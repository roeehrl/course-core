import React, { useEffect, useId, useRef, useState } from "react";
import { practiceRunner, type OutputStream, type PythonPracticeRunner, type RunResult } from "../connected/pythonRunner";
import { utf8Bytes } from "../connected/code";

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

const seconds = (ms: number) => `${(ms / 1000).toLocaleString("en-US", { maximumFractionDigits: ms < 10_000 ? 1 : 0 })} s`;
const mebibytes = (bytes: number) => `${Math.round(bytes / 1048576)} MB`;
const kilobytes = (bytes: number) => `${Math.round(bytes / 1024)} KB`;
export function resultMessage(result: RunResult, limits: PracticeRunnerHandle["limits"]): string {
  switch (result.status) {
    case "ok": return `Finished in ${seconds(result.durationMs)}.`;
    case "error": return `Finished with an error after ${seconds(result.durationMs)}. The traceback is in the output.`;
    case "timeout": return `Stopped: the run passed the ${seconds(limits.timeoutMs)} time limit. Look for a loop that never ends.`;
    case "output_limit": return `Stopped: the output passed ${kilobytes(limits.outputBytes)}. Print less, or print a summary.`;
    case "memory_limit": return `Stopped: the run needed more than ${mebibytes(limits.memoryBytes)} of memory.`;
    case "stopped": return "Stopped.";
    case "crashed": return "The Python runtime stopped unexpectedly. Run again to start a fresh one.";
    case "busy": return "A practice run is already in progress.";
    case "invalid": return "This code could not be sent to the practice runner.";
    default: return "Practice runs are unavailable right now. You can still submit your code for checking.";
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
      catch { setSampleError("The sample input is not valid JSON. Example: [3, 1, 2]"); return; }
    }
    setSampleError("");
    if (!source.trim()) { setStatus("Write some Python first, then run it."); return; }
    if (utf8Bytes(source) > runner.limits.sourceBytes) { setStatus("Your code is too long for a practice run. Shorten it first."); return; }
    pending.current = [];
    setChunks([]);
    setPhase("running");
    setStatus("Running…");
    const result = await runner.run(source, input, {
      onOutput,
      onPhase: (next) => {
        if (!mounted.current) return;
        if (next === "loading") setStatus("Loading Python in your browser (first run only, about 6 MB)…");
        else setStatus("Running…");
      },
    });
    if (!mounted.current) return;
    flush();
    setPhase("idle");
    setStatus(resultMessage(result, runner.limits));
  }
  function stop() {
    if (!runner || phase === "idle") return;
    setPhase("stopping");
    setStatus("Stopping…");
    runner.stop();
  }
  function reset() {
    if (!runner) return;
    runner.reset();
    pending.current = [];
    setChunks([]);
    setPhase("idle");
    setStatus("Python was reset. The next run starts a fresh interpreter.");
  }

  const empty = chunks.length === 0;
  return (
    <section className="connected-practice" aria-labelledby={`${id}-title`}>
      <div className="connected-practice-head">
        <p id={`${id}-title`} className="connected-practice-title">Practice run in your browser</p>
        <p id={`${id}-about`} className="connected-input-hint">
          Runs on this device with no network access. It is not graded, not sent to the course and never counts as evidence. Use “Run code &amp; check” to submit.
        </p>
      </div>
      <div className="connected-practice-sample">
        <label htmlFor={`${id}-sample`}>Sample input for solve (JSON, optional)</label>
        <input
          id={`${id}-sample`}
          type="text"
          value={sample}
          onChange={(event) => { setSample(event.target.value); setSampleError(""); }}
          disabled={busy}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          inputMode="text"
          maxLength={4000}
          placeholder="[3, 1, 2]"
          aria-describedby={sampleError ? `${id}-sample-error` : undefined}
          aria-invalid={sampleError ? true : undefined}
        />
        {sampleError && <p id={`${id}-sample-error`} className="connected-code-error">{sampleError}</p>}
      </div>
      <div className="connected-practice-actions">
        <button type="button" className="connected-practice-run" onClick={() => void start()} disabled={disabled || busy} aria-describedby={`${id}-about`}>
          Run in browser
        </button>
        <button type="button" onClick={stop} disabled={phase === "idle" || phase === "stopping"}>
          Stop
        </button>
        <button type="button" onClick={reset} disabled={busy}>
          Reset Python
        </button>
      </div>
      <p className="connected-practice-status" role="status">{status}</p>
      <pre className="connected-practice-output" role="log" aria-live="polite" aria-label="Practice run output" tabIndex={0} data-empty={empty || undefined}>
        {empty ? <span className="connected-practice-placeholder">Output appears here.</span> : chunks.map((chunk, index) => (
          <span key={index} className={chunk.stream === "stderr" ? "connected-practice-stderr" : undefined}>{chunk.text}</span>
        ))}
      </pre>
      <p className="connected-practice-runtime">
        Python via Pyodide {runner.runtime.version} ({runner.runtime.license.spdx}, <a href={runner.runtime.license.source} target="_blank" rel="noreferrer noopener">source</a>). Limits: {seconds(runner.limits.timeoutMs)}, {kilobytes(runner.limits.outputBytes)} of output, {mebibytes(runner.limits.memoryBytes)} of memory.
      </p>
    </section>
  );
}
