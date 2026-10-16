import React, { useEffect, useId, useRef, useState } from "react";
import type { ActivityClient, ActivityFallback, ActivityRun, ActivityTarget, JsonObject, JsonValue, ObservationResult } from "../client/activityClient";
import { FRAME_PATH } from "../client/activityClient";
import { ChoiceList, Field } from "../components/ui";
import { Button, Notice } from "../components/ui";
import { createFrameBroker } from "./activityBroker";

/** The sandbox attribute of every activity frame: scripts only. Never allow-same-origin (the frame
 * would share the app's origin, cookies and storage), forms, popups or top navigation. */
export const ACTIVITY_FRAME_SANDBOX = "allow-scripts";
const READY_TIMEOUT_CAP_MS = 30_000;

export const activityTarget = (width: number): ActivityTarget => (width < 600 ? "web_mobile" : "web_desktop");

type Control =
  | { id: string; label: string; kind: "number"; min: number; max: number; step?: number }
  | { id: string; label: string; kind: "choice"; options: { id: string; label: string }[] }
  | { id: string; label: string; kind: "toggle" };
interface Declarative { prompt: string; controls: Control[]; submitLabel?: string }
/** The declarative configuration as Core's interpreter defines it; the server validated it at
 * publication, and anything unexpected here is not rendered. */
export function declarativeConfiguration(value: JsonObject): Declarative | null {
  const { prompt, controls, submitLabel } = value as Record<string, unknown>;
  if (typeof prompt !== "string" || !Array.isArray(controls) || !controls.length || (submitLabel !== undefined && typeof submitLabel !== "string")) return null;
  const ok = controls.every((c) => {
    const control = c as Record<string, unknown>;
    if (typeof control?.id !== "string" || typeof control.label !== "string") return false;
    if (control.kind === "number") return typeof control.min === "number" && typeof control.max === "number";
    if (control.kind === "choice") return Array.isArray(control.options) && control.options.every((o) => typeof (o as Record<string, unknown>)?.id === "string" && typeof (o as Record<string, unknown>).label === "string");
    return control.kind === "toggle";
  });
  return ok ? (value as unknown as Declarative) : null;
}
const resultText = (result: ObservationResult) => ({
  passed: result.evaluation.explanation ? `Checked: done. ${result.evaluation.explanation}` : "Checked: done.",
  not_passed: `Checked: not yet. ${result.evaluation.explanation ?? "Look again and try once more."} Nothing else changes; you can try again.`,
  not_evaluated: "Saved. This activity is practice: it marks this step done but is never counted as evidence of mastery.",
  unavailable: "Your work was saved, but it could not be checked right now. Nothing was recorded against you. Try again later.",
})[result.evaluation.status];

export interface ActivityBlockProps {
  client: ActivityClient;
  enrollmentId: string;
  episodeId: string;
  blockId: string;
  /** From the server snapshot: the step's completion requirement is met. */
  done: boolean;
  disabled?: boolean;
  /** The server recorded something that changes the lesson (the step is now done). */
  onChanged: () => void;
}
export function ActivityBlock(props: ActivityBlockProps) {
  const [run, setRun] = useState<ActivityRun | ActivityFallback | null>(null);
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();
  useEffect(() => {
    let live = true;
    setRun(null);
    setError(null);
    props.client.launch(props.enrollmentId, props.episodeId, props.blockId, activityTarget(window.innerWidth))
      .then((value) => live && setRun(value))
      .catch(() => live && setError("This activity could not be opened. Your progress is saved; reload to try again."));
    return () => { live = false; };
  }, [props.client, props.enrollmentId, props.episodeId, props.blockId]);
  return (
    <section className="connected-activity" aria-labelledby={headingId} data-testid="activity-block">
      <div className="connected-part-top">
        <span>ACTIVITY</span>
        <span className="connected-activity-status">{props.done ? "Done" : "Not done yet"}</span>
      </div>
      <h2 id={headingId}>{run?.mode === "run" ? run.title : "Interactive activity"}</h2>
      {error && <Notice error>{error}</Notice>}
      {!run && !error && <p>Opening the activity…</p>}
      {run?.mode === "fallback" && (
        <Notice>
          This activity is not available on this device. Its author provided an equivalent {run.fallback.kind === "text_block" ? "reading" : run.fallback.kind}
          {" "}that covers the same goals; use it instead.
        </Notice>
      )}
      {run?.mode === "run" && (
        <>
          <p className="connected-activity-alternative">{run.accessibility.textAlternative}</p>
          {run.execution === "declarative" ? <DeclarativeActivity {...props} run={run} /> : <SandboxedActivity {...props} run={run} />}
        </>
      )}
    </section>
  );
}

function DeclarativeActivity(props: ActivityBlockProps & { run: ActivityRun }) {
  const { run, client } = props;
  const config = declarativeConfiguration(run.configuration);
  const saved = (run.state?.values ?? {}) as Record<string, JsonValue>;
  const [values, setValues] = useState<Record<string, JsonValue>>(saved);
  const [drafts, setDrafts] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(saved).filter(([, v]) => typeof v === "number").map(([k, v]) => [k, String(v)])));
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const revision = useRef(run.stateRevision), chain = useRef<Promise<unknown>>(Promise.resolve());
  if (!config) return <Notice error>This activity's content could not be shown.</Notice>;
  const canSave = run.grantedCapabilities.includes("state.patch"), canSubmit = run.grantedCapabilities.includes("observation.emit");
  function save(next: Record<string, JsonValue>) {
    if (!canSave) return;
    // Patches are serialized so each carries the revision the previous one produced.
    chain.current = chain.current.then(async () => {
      try {
        const result = await client.call<{ stateRevision: number }>(props.enrollmentId, run.instanceId, "state.patch", { state: { values: next } }, { expectedStateRevision: revision.current });
        revision.current = result.stateRevision;
      } catch { /* a value the server refuses is simply not saved; submitting re-checks everything */ }
    });
  }
  function update(id: string, value: JsonValue) {
    const next = { ...values, [id]: value };
    setValues(next);
    setMessage(null);
    save(next);
  }
  const missing = config.controls.filter((c) => values[c.id] === undefined || values[c.id] === null);
  async function submit() {
    if (missing.length) { setMessage({ text: `Answer every part first (${missing.length} left).`, error: true }); return; }
    setBusy(true);
    try {
      await chain.current;
      const result = await client.call<ObservationResult>(props.enrollmentId, run.instanceId, "observation.emit", { observation: { kind: "submitted", values } });
      setMessage({ text: resultText(result), error: result.evaluation.status === "unavailable" });
      if (result.satisfied && !props.done) props.onChanged();
    } catch (error) {
      const code = (error as { code?: string }).code;
      setMessage({ text: code === "ACTIVITY_RATE_LIMITED" ? "That was a lot of tries in a short time. Wait a minute, then submit again." : "Your answer could not be sent. Check your connection and try again.", error: true });
    } finally { setBusy(false); }
  }
  return (
    <form className="connected-activity-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <p>{config.prompt}</p>
      {config.controls.map((control) => {
        if (control.kind === "number") {
          return (
            <Field key={control.id} label={`${control.label} (${control.min} to ${control.max})`} value={drafts[control.id] ?? ""} inputMode="decimal" editable={!props.disabled && !busy}
              onChangeText={(text) => {
                setDrafts((all) => ({ ...all, [control.id]: text }));
                const number = Number(text.trim());
                if (text.trim() && Number.isFinite(number)) update(control.id, number);
                else update(control.id, null);
              }} />
          );
        }
        if (control.kind === "choice")
          return (
            <fieldset key={control.id} className="connected-activity-fieldset">
              <legend>{control.label}</legend>
              <ChoiceList label={control.label} options={control.options} value={typeof values[control.id] === "string" ? (values[control.id] as string) : ""} onChange={(id) => update(control.id, id)} disabled={props.disabled || busy} />
            </fieldset>
          );
        return (
          <label key={control.id} className="connected-activity-toggle">
            <input type="checkbox" checked={values[control.id] === true} disabled={props.disabled || busy} onChange={(event) => update(control.id, event.currentTarget.checked)} />
            <span>{control.label}</span>
          </label>
        );
      })}
      {message && <Notice error={message.error}>{message.text}</Notice>}
      {canSubmit && <Button label={config.submitLabel ?? "Submit"} kind="primary" disabled={props.disabled || busy} onPress={() => void submit()} />}
    </form>
  );
}

function SandboxedActivity(props: ActivityBlockProps & { run: ActivityRun }) {
  const { run, client } = props;
  const frame = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<"starting" | "ready" | "stopped">("starting");
  const [notice, setNotice] = useState<string | null>(null);
  const onChanged = useRef(props.onChanged), done = useRef(props.done);
  onChanged.current = props.onChanged;
  done.current = props.done;
  const url = run.frameUrl && FRAME_PATH.test(run.frameUrl) ? run.frameUrl : null;
  useEffect(() => {
    const element = frame.current;
    if (!element || !url) return;
    let loads = 0, port: MessagePort | null = null;
    const stop = (text: string) => { port?.close(); port = null; setStatus("stopped"); setNotice(text); };
    const timer = window.setTimeout(() => { if (!broker.ready) stop("This activity did not start in time and was stopped. Use the description above instead."); },
      Math.min(run.budget.timeoutMs, READY_TIMEOUT_CAP_MS));
    const broker = createFrameBroker({
      granted: run.grantedCapabilities,
      maxPayloadBytes: Math.max(run.budget.maxEventBytes, run.budget.maxStateBytes) + 64,
      stateRevision: run.stateRevision,
      forward: (capability, payload, expectedStateRevision) =>
        client.call(props.enrollmentId, run.instanceId, capability, payload, expectedStateRevision === undefined ? {} : { expectedStateRevision }),
      post: (reply) => port?.postMessage(reply),
      onReady: () => { window.clearTimeout(timer); setStatus("ready"); },
      onObserved: (result) => { if ((result as ObservationResult)?.satisfied && !done.current) onChanged.current(); },
    });
    const onLoad = () => {
      loads++;
      // The frame navigated itself away from Core's document: whatever is there now gets nothing.
      if (loads > 1) { stop("This activity left its frame and was stopped. Reload the lesson to start it again."); return; }
      const channel = new MessageChannel();
      port = channel.port1;
      port.onmessage = (event) => broker.handle(event.data);
      const context = { activityId: run.activityId, target: run.target, grantedCapabilities: run.grantedCapabilities, configuration: run.configuration,
        state: run.grantedCapabilities.includes("state.read") ? run.state : null, stateRevision: run.stateRevision };
      // The frame has an opaque origin, so "*" is the only possible target; the message carries no secrets.
      element.contentWindow?.postMessage({ type: "course-activity-init", context }, "*", [channel.port2]);
    };
    element.addEventListener("load", onLoad);
    // Navigate only once the listener is in place, so the first load is never missed.
    element.src = url;
    return () => { element.removeEventListener("load", onLoad); window.clearTimeout(timer); port?.close(); };
  }, [url, run, client, props.enrollmentId]);
  if (!url) return <Notice error>This activity could not be shown.</Notice>;
  return (
    <div className="connected-activity-frame-wrap">
      {status !== "stopped" && (
        <iframe ref={frame} className="connected-activity-frame" sandbox={ACTIVITY_FRAME_SANDBOX} title={`${run.title} (interactive activity)`}
          referrerPolicy="no-referrer" allow="" data-testid="activity-frame" />
      )}
      {status === "starting" && <p className="connected-input-hint">Starting the activity…</p>}
      {notice && <Notice error>{notice}</Notice>}
    </div>
  );
}
