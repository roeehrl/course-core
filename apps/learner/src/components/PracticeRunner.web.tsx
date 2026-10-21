import React, { useEffect, useId, useRef, useState } from "react";
import { practiceRunner, type OutputStream, type PythonPracticeRunner, type RunResult } from "../connected/pythonRunner";
import { utf8Bytes } from "../connected/code";
import { englishTranslator, useI18n, type LearnerTranslator } from "../i18n";

/** A JSON sample for `solve`; code, the same in every language. */
const SAMPLE_EXAMPLE = "[3, 1, 2]";
type Phase = "idle" | "loading" | "running" | "stopping";
type Chunk = { stream: OutputStream; text: string };
export interface PracticeRunnerProps {
  language: string;
  source: string;
  disabled?: boolean;
  /** Test seam: resolves the page's runner (null: no practice runs here). */
  loadRunner?: () => Promise<PracticeRunnerHandle | null>;
}
export type PracticeRunnerHandle = Pick<PythonPracticeRunner, "run" | "stop" | "reset"> & {
  limits: { timeoutMs: number; outputBytes: number; memoryBytes: number; sourceBytes: number };
  runtime: { version: string; license: { spdx: string; source: string } };
};

type Formatter = Pick<LearnerTranslator, "t" | "number">;
const seconds = (ms: number, i18n: Formatter) =>
  i18n.t("practiceRunner.unit.seconds", {
    value: i18n.number(ms / 1000, { maximumFractionDigits: ms < 10_000 ? 1 : 0 }),
  });
const mebibytes = (bytes: number, i18n: Formatter) =>
  i18n.t("practiceRunner.unit.megabytes", { value: Math.round(bytes / 1048576) });
const kilobytes = (bytes: number, i18n: Formatter) =>
  i18n.t("practiceRunner.unit.kilobytes", { value: Math.round(bytes / 1024) });
export function resultMessage(
  result: RunResult,
  limits: PracticeRunnerHandle["limits"],
  i18n: Formatter = englishTranslator(),
): string {
  const t = i18n.t;
  switch (result.status) {
    case "ok": return t("practiceRunner.result.ok", { time: seconds(result.durationMs, i18n) });
    case "error": return t("practiceRunner.result.error", { time: seconds(result.durationMs, i18n) });
    case "timeout": return t("practiceRunner.result.timeout", { time: seconds(limits.timeoutMs, i18n) });
    case "output_limit": return t("practiceRunner.result.output_limit", { size: kilobytes(limits.outputBytes, i18n) });
    case "memory_limit": return t("practiceRunner.result.memory_limit", { size: mebibytes(limits.memoryBytes, i18n) });
    case "stopped": return t("practiceRunner.result.stopped");
    case "crashed": return t("practiceRunner.result.crashed");
    case "busy": return t("practiceRunner.result.busy");
    case "invalid": return t("practiceRunner.result.invalid");
    default: return t("practiceRunner.result.unavailable");
  }
}

async function defaultRunner(): Promise<PracticeRunnerHandle | null> {
  const runner = await practiceRunner();
  if (!runner) return null;
  const { limits, runtime } = runner.config;
  return { run: runner.run.bind(runner), stop: runner.stop.bind(runner), reset: runner.reset.bind(runner), limits, runtime };
}

/**
 * Run the learner's Python in this browser, for practice. It runs in Core's sandboxed runner frame
 * with no network and no access to this page, is never sent to the server and never counts as
 * evidence. Grading stays with "Run code & check".
 */
export function PracticeRunner({ language, source, disabled, loadRunner = defaultRunner }: PracticeRunnerProps) {
  const i18n = useI18n(),
    t = i18n.t;
  const id = useId();
  const [runner, setRunner] = useState<PracticeRunnerHandle | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [status, setStatus] = useState("");
  const [sample, setSample] = useState("");
  const [sampleError, setSampleError] = useState("");
  const pending = useRef<Chunk[]>([]), frame = useRef<number | null>(null), mounted = useRef(true), runnerRef = useRef<PracticeRunnerHandle | null>(null), phaseRef = useRef<Phase>("idle");
  phaseRef.current = phase;

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    if (language === "python") void loadRunner().then((value) => { if (!cancelled) { runnerRef.current = value; setRunner(value); } }, () => {});
    return () => {
      cancelled = true;
      mounted.current = false;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      // Leaving the exercise ends its run; the interpreter stays for the next exercise.
      if (phaseRef.current !== "idle") runnerRef.current?.stop();
    };
  }, [language, loadRunner]);

  if (language !== "python" || !runner) return null;
  const busy = phase !== "idle";

  // Output arrives in many small pieces: render at most once per frame.
  const flush = () => {
    frame.current = null;
    if (!mounted.current || !pending.current.length) return;
    const next = pending.current;
    pending.current = [];
    setChunks((current) => {
      const merged = [...current];
      for (const chunk of next) {
        const last = merged[merged.length - 1];
        if (last && last.stream === chunk.stream) merged[merged.length - 1] = { stream: last.stream, text: last.text + chunk.text };
        else merged.push(chunk);
      }
      return merged;
    });
  };
  const onOutput = (stream: OutputStream, text: string) => {
    pending.current.push({ stream, text });
    if (frame.current === null) frame.current = requestAnimationFrame(flush);
  };

  async function start() {
    if (!runner || busy) return;
    let input: string | null = null;
    if (sample.trim()) {
      try { JSON.parse(sample); input = sample; }
      catch { setSampleError(t("practiceRunner.sampleInvalid", { example: SAMPLE_EXAMPLE })); return; }
    }
    setSampleError("");
    if (!source.trim()) { setStatus(t("practiceRunner.empty")); return; }
    if (utf8Bytes(source) > runner.limits.sourceBytes) { setStatus(t("practiceRunner.tooLong")); return; }
    pending.current = [];
    setChunks([]);
    setPhase("running");
    setStatus(t("practiceRunner.running"));
    const result = await runner.run(source, input, {
      onOutput,
      onPhase: (next) => {
        if (!mounted.current) return;
        if (next === "loading") setStatus(t("practiceRunner.loading"));
        else setStatus(t("practiceRunner.running"));
      },
    });
    if (!mounted.current) return;
    flush();
    setPhase("idle");
    setStatus(resultMessage(result, runner.limits, i18n));
  }
  function stop() {
    if (!runner || phase === "idle") return;
    setPhase("stopping");
    setStatus(t("practiceRunner.stopping"));
    runner.stop();
  }
  function reset() {
    if (!runner) return;
    runner.reset();
    pending.current = [];
    setChunks([]);
    setPhase("idle");
    setStatus(t("practiceRunner.resetDone"));
  }

  const empty = chunks.length === 0;
  return (
    <section className="connected-practice" aria-labelledby={`${id}-title`}>
      <div className="connected-practice-head">
        <p id={`${id}-title`} className="connected-practice-title">{t("practiceRunner.title")}</p>
        <p id={`${id}-about`} className="connected-input-hint">
          {t("practiceRunner.about")}
        </p>
      </div>
      <div className="connected-practice-sample">
        <label htmlFor={`${id}-sample`}>{t("practiceRunner.sampleLabel")}</label>
        <input
          id={`${id}-sample`}
          type="text"
          dir="ltr"
          value={sample}
          onChange={(event) => { setSample(event.target.value); setSampleError(""); }}
          disabled={busy}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          inputMode="text"
          maxLength={4000}
          placeholder={SAMPLE_EXAMPLE}
          aria-describedby={sampleError ? `${id}-sample-error` : undefined}
          aria-invalid={sampleError ? true : undefined}
        />
        {sampleError && <p id={`${id}-sample-error`} className="connected-code-error">{sampleError}</p>}
      </div>
      <div className="connected-practice-actions">
        <button type="button" className="connected-practice-run" onClick={() => void start()} disabled={disabled || busy} aria-describedby={`${id}-about`}>
          {t("practiceRunner.run")}
        </button>
        <button type="button" onClick={stop} disabled={phase === "idle" || phase === "stopping"}>
          {t("practiceRunner.stop")}
        </button>
        <button type="button" onClick={reset} disabled={busy}>
          {t("practiceRunner.reset")}
        </button>
      </div>
      <p className="connected-practice-status" role="status">{status}</p>
      <pre className="connected-practice-output" role="log" aria-live="polite" aria-label={t("practiceRunner.outputLabel")} dir="ltr" tabIndex={0} data-empty={empty || undefined}>
        {empty ? <span className="connected-practice-placeholder" dir={i18n.dir}>{t("practiceRunner.outputEmpty")}</span> : chunks.map((chunk, index) => (
          <span key={index} className={chunk.stream === "stderr" ? "connected-practice-stderr" : undefined}>{chunk.text}</span>
        ))}
      </pre>
      <p className="connected-practice-runtime">
        {i18n.rich(
          "practiceRunner.runtime",
          {
            version: runner.runtime.version,
            spdx: runner.runtime.license.spdx,
            time: seconds(runner.limits.timeoutMs, i18n),
            output: kilobytes(runner.limits.outputBytes, i18n),
            memory: mebibytes(runner.limits.memoryBytes, i18n),
          },
          {
            link: (children, key) => (
              <a key={key} href={runner.runtime.license.source} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ),
          },
        )}
      </p>
    </section>
  );
}
