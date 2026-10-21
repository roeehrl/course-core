import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createDatabase } from "../src/database.js";
import { migrate } from "../src/migrations.js";
import { createServer } from "../src/server.js";
import { offsetClock } from "../src/clock.js";
import { rehearseStudy } from "../src/study-rehearsal.js";
import type { RuntimeExtension } from "../src/publication.js";
import { svgRenderer } from "../src/svg-renderer.js";
import { reviewedRubricEvaluator } from "../src/rubric-evaluator.js";
import { declarativeActivityRuntime } from "../src/activity-runtime.js";
import { declarativeActivityEvaluator } from "../src/declarative-evaluator.js";
import { codeEvaluator } from "../src/code-evaluator.js";
import { composeAdaptation } from "../src/adaptation-composition.js";
import type { DockerSandbox } from "@course-core/sandbox";

/** Runs a course's study definition end to end with scripted participants (src/study-rehearsal.ts)
 * in a fresh schema of a disposable local database, then prints the checks and counts as JSON.
 *
 *   TEST_DATABASE_URL=postgres://…/course_core_test_x npm run study:rehearse -- \
 *     --course <source manifest .json> --study <study.json> [--participants 30] [--seed text] [--csv out.csv]
 *     [--code-fixtures a.json,b.json] [--adaptation bounded-numeric-v1,authored-bank-v1]
 *
 * --course is the course's source manifest (what the import route takes); --study is a file with
 * a `definition` object in the admin's study shape (title, purpose, arms, instruments,
 * minCellSize, usabilityMeasures?). Nothing is written outside the new schema, which is dropped
 * at the end, except the optional CSV (pseudonymous, synthetic participants only). Exit code 1 when
 * a check fails.
 *
 * The server gets the same built-in extensions as a real host (main.ts). A course with code tasks
 * also needs its code-fixture files (--code-fixtures) and, with adaptation declarations, the
 * trusted adapters the host runs (--adaptation, the same ids as ADAPTATION_ADAPTERS) so it can be published. No code is ever run: the evaluators
 * get a sandbox that refuses every run (it reports itself ready so publication accepts the course), and scripted participants skip code items. */
const { values } = parseArgs({ options: {
  course: { type: "string" }, study: { type: "string" }, participants: { type: "string", default: "30" },
  seed: { type: "string", default: "study-rehearsal" }, csv: { type: "string" }, keep: { type: "boolean", default: false },
  "code-fixtures": { type: "string" }, adaptation: { type: "string" },
} });
if (!values.course || !values.study) throw Error("Usage: study:rehearse -- --course <manifest.json> --study <study.json> [--participants n] [--seed s] [--csv file]");
const participants = Number(values.participants);
if (!Number.isInteger(participants) || participants < 2 || participants > 500) throw Error("--participants must be a whole number from 2 to 500");
const url = new URL(process.env.TEST_DATABASE_URL ?? "");
if (process.env.DATABASE_URL || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/^\/course_core_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname) || url.search || url.hash)
  throw Error("Explicit disposable loopback database required (TEST_DATABASE_URL=postgres://127.0.0.1/course_core_test_<name>; no DATABASE_URL)");
// The retention schedule needs days to pass; only a test server accepts a moved clock.
if (process.env.NODE_ENV !== "test") throw Error("Run through `npm run study:rehearse`, which sets NODE_ENV=test for the rehearsal clock");
const course = JSON.parse(await readFile(path.resolve(values.course), "utf8"));
const study = JSON.parse(await readFile(path.resolve(values.study), "utf8"));
const schema = "rehearsal_" + randomUUID().replaceAll("-", "");
const root = createDatabase(url.href);
await root.query("CREATE SCHEMA " + schema);
url.searchParams.set("options", "-csearch_path=" + schema);
const db = createDatabase(url.href);
const origin = "http://127.0.0.1";
let failed = true;
try {
  await migrate(db, fileURLToPath(new URL("../migrations", import.meta.url)));
  const clock = offsetClock();
  // Reports ready so the course can be published, then refuses every run (the API answers 503):
  // the rehearsal answers no code item.
  const noRuns = { readiness: async () => ({ ready: true }), grade: async () => ({ status: "unavailable" }) } as unknown as DockerSandbox;
  const installedExtensions: RuntimeExtension[] = [await svgRenderer(), reviewedRubricEvaluator(), declarativeActivityRuntime(), declarativeActivityEvaluator()];
  for (const file of (values["code-fixtures"] ?? "").split(",").filter(Boolean)) installedExtensions.push(await codeEvaluator(await readFile(path.resolve(file)), noRuns));
  const adaptation = composeAdaptation((values.adaptation ?? "").split(",").filter(Boolean), installedExtensions);
  const app = await createServer(db, { loginCodes: true, origin, secureCookies: false, clock, installedExtensions, adaptation });
  try {
    let csv = "";
    const report = await rehearseStudy({ app, db, clock, origin, course, study, participants, seed: values.seed, onExport: (body) => { csv = body; } });
    console.log(JSON.stringify(report, null, 2));
    // Pseudonymous and synthetic: scripted participants only.
    if (values.csv) await writeFile(path.resolve(values.csv), csv, { flag: "wx", mode: 0o600 });
    failed = !report.ok;
  } finally {
    await app.close();
  }
} finally {
  await db.end();
  if (!values.keep) await root.query(`DROP SCHEMA ${schema} CASCADE`);
  await root.end();
}
process.exitCode = failed ? 1 : 0;
