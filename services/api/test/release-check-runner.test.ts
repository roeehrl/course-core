import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compileCourse } from "@course-core/sdk/compiler";
import type { Database } from "../src/database.js";
import { releaseCheckRunner, releaseChecksFor, releaseCheckStatistics, settleReleaseChecks, type ReleaseSummary } from "../src/admin-routes.js";
import type { RuntimeExtension } from "../src/publication.js";
import { fixture } from "./fixture.js";

// The background runner behind the admin course view (admin-routes.ts releaseCheckRunner): a
// stub pool stands in for PostgreSQL, so these cover queueing, waiting and failure only.
function stubDatabase() {
  const compiled = compileCourse(fixture()), release = { id: randomUUID(), digest: compiled.digest, row_version: "41" };
  const stub = { release, bundleReads: 0, fail: 0, hold: undefined as Promise<void> | undefined };
  const db = {
    async query(sql: string) {
      if (stub.fail > 0) { stub.fail--; throw new Error("connection lost"); }
      if (!sql.includes("server_bundle")) return { rows: [release] };
      stub.bundleReads++;
      await stub.hold;
      return { rows: [{ ...release, server_bundle: compiled.server }] };
    },
  } as unknown as Database;
  return { db, stub, summary: release as unknown as ReleaseSummary };
}
const options = { installedExtensions: [] as RuntimeExtension[] };

describe("release check runner", () => {
  it("queues a release once however often it is asked, and a view then reuses the recorded checks", async () => {
    const { db, stub, summary } = stubDatabase(), before = releaseCheckStatistics();
    const { checks, pending } = releaseChecksFor([summary], options);
    expect(checks.size).toBe(0);
    expect([...pending.keys()]).toEqual([summary.id]);
    const runner = releaseCheckRunner(db);
    expect(releaseCheckRunner(db)).toBe(runner);
    const [settled] = await Promise.all([settleReleaseChecks(db, pending, { ...options, releaseCheckWaitMs: 60_000 }),
      runner.schedule(summary.id, options), runner.schedule(summary.id, options)]);
    expect(settled.get(summary.id)?.map((c) => c.code)).toEqual(["SDK_DIGEST_MATCHES", "RUNTIME_SUPPORTED"]);
    expect(stub.bundleReads).toBe(1);
    expect(releaseCheckStatistics().computed - before.computed).toBe(1);
    // Known now: no bundle read, nothing pending.
    const again = releaseChecksFor([summary], options);
    expect({ known: again.checks.size, pending: again.pending.size }).toEqual({ known: 1, pending: 0 });
    await runner.schedule(summary.id, options);
    expect(stub.bundleReads).toBe(1);
  });

  it("answers without the checks when they do not finish within the wait, and records them when they do", async () => {
    const { db, stub, summary } = stubDatabase();
    let release!: () => void;
    stub.hold = new Promise((resolve) => { release = resolve; });
    const { pending } = releaseChecksFor([summary], options);
    const start = performance.now();
    expect((await settleReleaseChecks(db, pending, { ...options, releaseCheckWaitMs: 0 })).size).toBe(0);
    expect((await settleReleaseChecks(db, pending, { ...options, releaseCheckWaitMs: 50 })).size).toBe(0);
    expect(performance.now() - start).toBeLessThan(2_000);
    release();
    await releaseCheckRunner(db).idle();
    expect((await settleReleaseChecks(db, pending, { ...options, releaseCheckWaitMs: 0 })).size).toBe(1);
    expect(stub.bundleReads).toBe(1);
  });

  it("records nothing when an attempt fails, and the next request checks again", async () => {
    const { db, stub, summary } = stubDatabase(), runner = releaseCheckRunner(db);
    stub.fail = 1;
    const { pending } = releaseChecksFor([summary], options);
    expect((await settleReleaseChecks(db, pending, { ...options, releaseCheckWaitMs: 60_000 })).size).toBe(0);
    await runner.idle();
    expect(releaseChecksFor([summary], options).pending.size).toBe(1);
    expect((await settleReleaseChecks(db, pending, { ...options, releaseCheckWaitMs: 60_000 })).size).toBe(1);
  });
});
