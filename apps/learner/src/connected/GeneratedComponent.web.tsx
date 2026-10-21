import React, { useEffect, useId, useRef, useState } from "react";
import { isAbortError, type CourseApi } from "../client/apiClient";
import { practiceRunner, type RunResult } from "./pythonRunner";
import { Button } from "../components/ui";
import { useI18n } from "../i18n";

/**
 * A generated interactive component (requirement E05): a small Python model the supervisor wrote,
 * tested in the server's isolated grader before it was published. Here it runs only in Core's
 * sandboxed runner frame (opaque origin, no network, no access to this page), exactly like a
 * practice run. This page sends it the learner's control values and shows the JSON it returns as
 * plain text; nothing it computes is sent to the server or counts as an answer.
 */
export interface GeneratedComponent {
  episodeId: string;
  blockId: string;
  digest: string;
  title: string;
  description: string;
  source: string;
  inputs: { name: string; label: string; min: number; max: number; step: number; initial: number }[];
  outputs: { name: string; label: string }[];
}
type Runner = { run: (code: string, input: string | null, callbacks: { onOutput(stream: "stdout" | "stderr", text: string): void; onPhase?(phase: "loading" | "running"): void }) => Promise<RunResult> };

/** Published components of this learner's live personal changes, by `${episodeId}/${blockId}`. */
export function useGeneratedComponents(api: CourseApi, enrollmentId: string | undefined, revision: number) {
  const [components, setComponents] = useState<Map<string, GeneratedComponent>>(new Map());
  useEffect(() => {
    if (!enrollmentId) return setComponents(new Map());
    const controller = new AbortController();
    api
      .request<{ components: GeneratedComponent[] }>(`/api/enrollments/${encodeURIComponent(enrollmentId)}/components`, "GET", undefined, { signal: controller.signal })
      .then((value) => !controller.signal.aborted && setComponents(new Map((value.components ?? []).map((c) => [`${c.episodeId}/${c.blockId}`, c]))))
      // Without the list the lesson shows each component's text alternative only.
      .catch((error) => !controller.signal.aborted && !isAbortError(error) && setComponents(new Map()));
    return () => controller.abort();
  }, [api, enrollmentId, revision]);
  return components;
}

const MARKER = "COURSE-COMPONENT-RESULT:";
/** The model plus a call of `solve` on the learner's values, printing one marked JSON line. */
export function componentProgram(source: string, values: Record<string, number>) {
  // A JSON string is also a valid Python string literal; the values are finite numbers only.
  return `${source}\nimport json as _course_component_json\nprint(${JSON.stringify(MARKER)} + _course_component_json.dumps(solve(_course_component_json.loads(${JSON.stringify(JSON.stringify(values))}))))\n`;
}
/** The declared outputs from the run's output, or null when anything else came back. */
export function componentResult(stdout: string, outputs: GeneratedComponent["outputs"]): Record<string, number | string> | null {
  const line = stdout.split("\n").reverse().find((row) => row.startsWith(MARKER));
  if (!line) return null;
  try {
    const value = JSON.parse(line.slice(MARKER.length)) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const result = value as Record<string, unknown>, names = outputs.map((o) => o.name);
    if (Object.keys(result).length !== names.length || !names.every((name) => Object.hasOwn(result, name))) return null;
    for (const name of names) {
      const item = result[name];
      if (!(typeof item === "number" && Number.isFinite(item)) && !(typeof item === "string" && item.length <= 200)) return null;
    }
    return result as Record<string, number | string>;
  } catch {
    return null;
  }
}

export function GeneratedComponentPanel({ component, loadRunner = practiceRunner }: { component: GeneratedComponent; loadRunner?: () => Promise<Runner | null> }) {
  const i18n = useI18n(),
    t = i18n.t,
    id = useId();
  const [values, setValues] = useState<Record<string, number>>(() => Object.fromEntries(component.inputs.map((i) => [i.name, i.initial])));
  const [phase, setPhase] = useState<"idle" | "loading" | "running">("idle");
  const [result, setResult] = useState<Record<string, number | string> | null>(null);
  const [status, setStatus] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function run() {
    setStatus("");
    const runner = await loadRunner().catch(() => null);
    if (!runner) return mounted.current && setStatus(t("generatedComponent.unavailable"));
    let stdout = "";
    setPhase("running");
    const outcome = await runner.run(componentProgram(component.source, values), null, {
      onOutput: (stream, text) => {
        if (stream === "stdout" && stdout.length < 65_536) stdout += text;
      },
      onPhase: (next) => mounted.current && setPhase(next),
    });
    if (!mounted.current) return;
    setPhase("idle");
    const parsed = outcome.status === "ok" ? componentResult(stdout, component.outputs) : null;
    setResult(parsed);
    setStatus(outcome.status === "unavailable" ? t("generatedComponent.unavailable")
      : outcome.status !== "ok" ? t("generatedComponent.failed")
        : parsed ? t("generatedComponent.updated") : t("generatedComponent.badOutput"));
  }
  const busy = phase !== "idle";
  return (
    <section className="connected-component" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>{component.title}</h3>
      <p className="connected-muted" id={`${id}-note`}>{t("generatedComponent.note")}</p>
      <fieldset disabled={busy}>
        <legend>{t("generatedComponent.controls")}</legend>
        {component.inputs.map((input) => (
          <label key={input.name} className="connected-component-control">
            <span>{input.label}</span>
            <input
              type="number"
              inputMode="decimal"
              min={input.min}
              max={input.max}
              step={input.step}
              value={values[input.name]}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (Number.isFinite(next)) setValues((all) => ({ ...all, [input.name]: Math.min(input.max, Math.max(input.min, next)) }));
              }}
            />
          </label>
        ))}
      </fieldset>
      <Button
        label={phase === "loading" ? t("generatedComponent.loading") : phase === "running" ? t("generatedComponent.running") : t("generatedComponent.run")}
        kind="primary"
        disabled={busy}
        describedBy={`${id}-note`}
        onPress={() => void run()}
      />
      <div aria-live="polite">
        {status && <p className="connected-muted">{status}</p>}
        <dl className="connected-component-results" aria-label={t("generatedComponent.results")}>
          {component.outputs.map((output) => (
            <div key={output.name}>
              <dt>{output.label}</dt>
              <dd>
                {result === null
                  ? t("generatedComponent.notRun")
                  : typeof result[output.name] === "number"
                    ? i18n.number(result[output.name] as number, { maximumFractionDigits: 6 })
                    : String(result[output.name])}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
