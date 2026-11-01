import React, { startTransition, useEffect, useId, useRef, useState } from "react";
import { isAbortError, type CourseApi } from "../client/apiClient";
import { practiceRunner, type RunResult } from "./pythonRunner";
import { Icon } from "../components/icons/Icon.web";
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
  /** The outputs at the starting position, as the server's grader verified them before delivery. */
  start?: { outputs: Record<string, number | string> };
}
type Runner = { run: (code: string, input: string | null, callbacks: { onOutput(stream: "stdout" | "stderr", text: string): void; onPhase?(phase: "loading" | "running"): void }) => Promise<RunResult> };

/** Published components of this learner's live personal changes, by `${episodeId}/${blockId}`. */
export function useGeneratedComponents(api: CourseApi, enrollmentId: string | undefined, revision: number) {
  const [components, setComponents] = useState<Map<string, GeneratedComponent>>(new Map());
  useEffect(() => {
    if (!enrollmentId) return setComponents(new Map());
    // A background reload after a revision: applied as a transition, so it never holds back the
    // paint of what the learner just did (an answer's result, a started check).
    const controller = new AbortController();
    api
      .request<{ components: GeneratedComponent[] }>(`/api/enrollments/${encodeURIComponent(enrollmentId)}/components`, "GET", undefined, { signal: controller.signal })
      .then((value) => !controller.signal.aborted && startTransition(() => setComponents(new Map((value.components ?? []).map((c) => [`${c.episodeId}/${c.blockId}`, c])))))
      // Without the list the lesson shows each component's text alternative only.
      .catch((error) => !controller.signal.aborted && !isAbortError(error) && startTransition(() => setComponents(new Map())));
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

/** What the last press of "Run the model" ended in. */
type Outcome = "none" | "updated" | "failed" | "badOutput" | "unavailable";

/**
 * The model's panel (§4.6, 18b): its values, "Run the model" (which keeps its width while Python
 * loads and runs), a results box whose room is kept from the start, and the sandbox note, always
 * shown. Values that do not run are said under the values, with the first one focused to change;
 * output that looks wrong is hidden and said in the results box; a browser that cannot run models
 * says so in place of the button. The description above the panel always has the same information.
 */
export function GeneratedComponentPanel({ component, loadRunner = practiceRunner }: { component: GeneratedComponent; loadRunner?: () => Promise<Runner | null> }) {
  const i18n = useI18n(),
    t = i18n.t,
    id = useId();
  const [values, setValues] = useState<Record<string, number>>(() => Object.fromEntries(component.inputs.map((i) => [i.name, i.initial])));
  const [phase, setPhase] = useState<"idle" | "loading" | "running">("idle");
  const [result, setResult] = useState<Record<string, number | string> | null>(null);
  const [outcome, setOutcome] = useState<Outcome>("none");
  const mounted = useRef(true);
  const firstField = useRef<HTMLInputElement>(null);
  const cannotRun = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const busy = phase !== "idle";
  async function run() {
    if (busy) return;
    setOutcome("none");
    setPhase("loading");
    const runner = await loadRunner().catch(() => null);
    if (!mounted.current) return;
    if (!runner) {
      setPhase("idle");
      setOutcome("unavailable");
      // The button goes; the line that replaces it takes the focus it had.
      return requestAnimationFrame(() => cannotRun.current?.focus());
    }
    let stdout = "";
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
    const next: Outcome = outcome.status === "unavailable" ? "unavailable" : outcome.status !== "ok" ? "failed" : parsed ? "updated" : "badOutput";
    setOutcome(next);
    if (next === "unavailable") requestAnimationFrame(() => cannotRun.current?.focus());
  }
  // Values that did not run: the first one is ready to change, once the values are enabled again.
  useEffect(() => {
    if (outcome === "failed") firstField.current?.focus();
  }, [outcome]);
  // Before a run, at the starting position, the verified starting values are shown instead of nothing.
  const atStart = component.inputs.every((input) => values[input.name] === input.initial);
  const shown = outcome === "badOutput" ? null : result ?? (atStart && component.start ? component.start.outputs : null);
  const value = (item: number | string | undefined) =>
    item === undefined ? t("generatedComponent.notRun") : typeof item === "number" ? i18n.number(item, { maximumFractionDigits: 6 }) : String(item);
  const bdi = { bdi: (children: React.ReactNode, key: string | number) => <bdi key={key}>{children}</bdi> };
  return (
    <section className="connected-component" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>{component.title}</h3>
      <fieldset disabled={busy}>
        <legend className="cc-ui-sr-only">{t("generatedComponent.controls")}</legend>
        {component.inputs.map((input, index) => (
          <label key={input.name} className="connected-component-control">
            <span>{input.label}</span>
            <input
              ref={index === 0 ? firstField : undefined}
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
      {outcome === "failed" && (
        <p className="cc-ui-status is-error cc-ai-model-line" role="alert">
          <Icon name="alert-circle" size={16} />
          <span>{t("generatedComponent.failed")}</span>
          <button type="button" className="cc-ui-text-button" onClick={() => firstField.current?.focus()}>
            {t("generatedComponent.tryOther")}
          </button>
        </p>
      )}
      {outcome === "unavailable" ? (
        <p ref={cannotRun} className="cc-ui-status is-error cc-ai-model-line" role="alert" tabIndex={-1}>
          <Icon name="alert-circle" size={16} />
          <span>{t("generatedComponent.unavailable")}</span>
        </p>
      ) : (
        <button
          type="button"
          className="cc-ui-pill cc-ui-pill-accent cc-ui-pill-40 cc-ai-model-run"
          aria-disabled={busy || undefined}
          aria-describedby={`${id}-note`}
          onClick={() => void run()}
        >
          {busy && <span className="cc-ai-spinner" aria-hidden="true" />}
          <span>{phase === "loading" ? i18n.rich("generatedComponent.loading", undefined, bdi) : phase === "running" ? t("generatedComponent.running") : t("generatedComponent.run")}</span>
        </button>
      )}
      {/* The results' room is kept from the start, so a run never moves what follows. */}
      <div className="cc-ai-model-results" aria-live="polite">
        {outcome === "updated" && <p className="cc-ai-model-status">{t("generatedComponent.updated")}</p>}
        {outcome === "badOutput" && (
          <p className="cc-ui-status is-error">
            <Icon name="alert-circle" size={16} />
            <span>{t("generatedComponent.badOutput")}</span>
          </p>
        )}
        {result === null && shown && <p className="cc-ai-model-status">{t("generatedComponent.startChecked")}</p>}
        {outcome !== "badOutput" && outcome !== "unavailable" && (
          <dl className="connected-component-results" aria-label={t("generatedComponent.results")}>
            {component.outputs.map((output) => (
              <div key={output.name}>
                <dt>{output.label}</dt>
                <dd>{shown === null ? t("generatedComponent.notRun") : value(shown[output.name])}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      <p className="cc-ai-model-note" id={`${id}-note`}>{t("generatedComponent.note")}</p>
    </section>
  );
}
