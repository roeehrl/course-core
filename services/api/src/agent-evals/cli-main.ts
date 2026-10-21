import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { composeProviders, providerConfigurationSchema } from "../provider-composition.js";
import { safeConfiguration } from "../provider-setup.js";
import { PUBLIC_SCRIPTED_MODELS, publicSuite, scriptedOutputsSchema } from "./public-suite.js";
import { reviewerJudge, runSuite, type EvalReport } from "./runner.js";
import { scriptedRuntime, type ScriptedAnswer } from "./scripted-model.js";
import { EVAL_ROLES, loadSuiteDirectory, SuiteError, type EvalRole, type EvalSuite } from "./suite.js";

/** The opt-in environment variable for live provider runs. Nothing in Core's CI sets it. */
export const LIVE_OPT_IN = "COURSE_AGENT_EVALS_LIVE";
const USAGE = `Usage: npm run eval:agents -- [options]

Scripted (default, offline):
  --model reference|known-bad    scripted model for the public suite (default reference)
  --fixtures DIR                 run an external suite instead (DIR/suite.json, DIR/dialogues/*.json)
  --scripted FILE                scripted answers for --fixtures (default DIR/scripted/<model>.json)
  --all-roles                    bind every role (tool loop, research, reviewer, media image) to the
                                 scripted model instead of companion and supervisor plan only
Live (opt-in, never in Core CI):
  --live --configuration FILE    provider configuration JSON; requires ${LIVE_OPT_IN}=1 and every
                                 credential it names set in the environment
  --judge                        also run the advisory LLM judge through the bound reviewer role
Common:
  --role ROLE                    limit to one role: companion, supervisor, research, reviewer, media (repeatable)
  --report FILE                  write the JSON report (for POST .../provider-evals/results)
  --expect-fail                  exit 0 only when the suite fails (to check the known-bad model)`;

export interface CliIo { stdout(text: string): void; stderr(text: string): void; writeFile(file: string, text: string): Promise<void> }
class UsageError extends Error {}

function summary(report: EvalReport, suite: EvalSuite) {
  const lines = [`Suite ${suite.id}@${suite.version} (${suite.digest.slice(0, 12)}), ${report.mode}${report.model ? ` model ${report.model}` : ""}`];
  for (const role of report.roles) {
    lines.push(`  ${role.role} (${role.strategy}) revision ${role.revisionDigest.slice(0, 12)}: ${role.passed ? "PASS" : "FAIL"}`);
    for (const d of role.dialogues) {
      const failed = d.grade.graders.filter((g) => !g.passed).map((g) => `${g.grader}[${g.findings.join(",")}]`);
      lines.push(`    ${d.grade.passed ? "pass" : "FAIL"} ${d.dialogueId}${failed.length ? "  " + failed.join(" ") : ""}${d.advisory ? `  (advisory judge: ${d.advisory.state})` : ""}`);
    }
  }
  for (const s of report.skipped) lines.push(`  ${s.role}: skipped (${s.reason})`);
  lines.push(report.passed ? "Result: PASS" : "Result: FAIL");
  lines.push(report.mode === "scripted" ? "Scripted answers test the graders and Core's prompt path, not any real model's quality." : "Live answers were graded deterministically; this is regression evidence, not proof of learning quality.");
  return lines.join("\n") + "\n";
}

async function readJson(file: string) {
  try { return JSON.parse(await readFile(file, "utf8")) as unknown; } catch { throw new UsageError(`Cannot read JSON from ${path.basename(file)}`); }
}

/** The runner's command line. Returns the process exit code: 0 expected outcome, 1 unexpected, 2 usage/configuration error. */
export async function runCli(argv: string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  try {
    const { values } = parseArgs({ args: argv, strict: true, options: {
      model: { type: "string", default: "reference" }, fixtures: { type: "string" }, scripted: { type: "string" },
      live: { type: "boolean", default: false }, configuration: { type: "string" }, judge: { type: "boolean", default: false },
      "all-roles": { type: "boolean", default: false }, role: { type: "string", multiple: true }, report: { type: "string" }, "expect-fail": { type: "boolean", default: false }, help: { type: "boolean", default: false },
    } });
    if (values.help) { io.stdout(USAGE + "\n"); return 0; }
    const roles = values.role?.map((role) => { if (!(EVAL_ROLES as string[]).includes(role)) throw new UsageError(`Unknown role ${role}`); return role as EvalRole; });
    const suite = values.fixtures ? await loadSuiteDirectory(path.resolve(values.fixtures)) : publicSuite();
    let report: EvalReport;
    if (values.live) {
      if (env[LIVE_OPT_IN] !== "1") throw new UsageError(`Live mode needs ${LIVE_OPT_IN}=1 in the environment.`);
      if (!values.configuration) throw new UsageError("Live mode needs --configuration FILE.");
      const parsed = providerConfigurationSchema.safeParse(await readJson(path.resolve(values.configuration)));
      if (!parsed.success) throw new UsageError("The provider configuration is invalid.");
      try { safeConfiguration(parsed.data); } catch { throw new UsageError("The provider configuration contains a secret-like field."); }
      const names = parsed.data.adapters.flatMap((a) => [a.credentialEnv, a.automaticFallback?.credentialEnv]).filter((n): n is string => !!n);
      const missing = names.filter((name) => !env[name]);
      if (missing.length || !names.length) throw new UsageError(`Live mode needs operator-configured credentials: ${missing.join(", ") || "(none named)"}.`);
      let runtime;
      try { runtime = composeProviders(parsed.data, (name) => env[name]); } catch { throw new UsageError("The provider configuration could not be composed."); }
      if (values.judge && runtime.availability("reviewer").status !== "ready") throw new UsageError("--judge needs a ready reviewer role in the configuration.");
      report = await runSuite({ suite, configuration: parsed.data, runtime, mode: "live", ...(roles ? { roles } : {}), ...(values.judge ? { judge: reviewerJudge(runtime) } : {}) });
    } else {
      if (values.configuration || values.judge) throw new UsageError("--configuration and --judge are live-mode options.");
      if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(values.model)) throw new UsageError("Invalid --model name.");
      let outputs: Record<string, ScriptedAnswer>;
      if (values.fixtures || values.scripted) {
        const file = values.scripted ? path.resolve(values.scripted) : path.join(path.resolve(values.fixtures!), "scripted", `${values.model}.json`);
        const parsed = scriptedOutputsSchema.safeParse(await readJson(file));
        if (!parsed.success) throw new UsageError("Scripted answers are invalid.");
        outputs = parsed.data;
      } else {
        if (!Object.hasOwn(PUBLIC_SCRIPTED_MODELS, values.model)) throw new UsageError(`Unknown scripted model ${values.model}.`);
        outputs = PUBLIC_SCRIPTED_MODELS[values.model as keyof typeof PUBLIC_SCRIPTED_MODELS];
      }
      const { scripted, configuration, runtime } = scriptedRuntime(values.model, outputs, values["all-roles"] ? "all" : "companion_supervisor");
      report = await runSuite({ suite, configuration, runtime, mode: "scripted", model: values.model, ...(roles ? { roles } : {}),
        beforeDialogue: (dialogue) => { scripted.current = dialogue.id; } });
    }
    io.stdout(summary(report, suite));
    if (values.report) await io.writeFile(path.resolve(values.report), JSON.stringify(report, null, 2) + "\n");
    return values["expect-fail"] ? (report.passed ? 1 : 0) : (report.passed ? 0 : 1);
  } catch (error) {
    if (error instanceof UsageError || (error as { code?: string }).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" || error instanceof SuiteError || (error as { code?: string }).code === "ENOENT") {
      io.stderr(`${(error as Error).message}\n\n${USAGE}\n`);
      return 2;
    }
    throw error;
  }
}
