import React, { useEffect, useId, useRef, useState } from "react";
import type { ActivityClient, ActivityFallback, ActivityRun, ActivityTarget, JsonObject, JsonValue, ObservationResult } from "../client/activityClient";
import { FRAME_PATH } from "../client/activityClient";
import { ChoiceList, Field } from "../components/ui";
import { Button, Notice } from "../components/ui";
import { createFrameBroker } from "./activityBroker";
import { englishTranslator, useT, type Translate } from "../i18n";
import { courseContentAttributes } from "../domain/contentLanguage";

/** The sandbox attribute of every activity frame: scripts only. Never allow-same-origin (the frame
 * would share the app's origin, cookies and storage), forms, popups or top navigation. */
export const ACTIVITY_FRAME_SANDBOX = "allow-scripts";
const READY_TIMEOUT_CAP_MS = 30_000;
/** Activity state is saved after this pause in typing, never on every keystroke. */
export const SAVE_PAUSE_MS = 1_000;

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
export function resultText(result: ObservationResult, t: Translate = englishTranslator().t) {
  const explanation = result.evaluation.explanation;
  switch (result.evaluation.status) {
    case "passed":
      return explanation ? t("activityBlock.result.passedWith", { explanation }) : t("activityBlock.result.passed");
    case "not_passed":
      return explanation ? t("activityBlock.result.notPassedWith", { explanation }) : t("activityBlock.result.notPassed");
    case "not_evaluated":
      return t("activityBlock.result.notEvaluated");
    default:
      return t("activityBlock.result.unavailable");
  }
}

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
  const t = useT();
  const [run, setRun] = useState<ActivityRun | ActivityFallback | null>(null);
  const [error, setError] = useState<"openFailed" | null>(null);
  const headingId = useId();
  useEffect(() => {
    let live = true;
    setRun(null);
    setError(null);
    props.client.launch(props.enrollmentId, props.episodeId, props.blockId, activityTarget(window.innerWidth))
      .then((value) => live && setRun(value))
      .catch(() => live && setError("openFailed"));
    return () => { live = false; };
  }, [props.client, props.enrollmentId, props.episodeId, props.blockId]);
  return (
    <section className="connected-activity" aria-labelledby={headingId} data-testid="activity-block">
      <div className="connected-part-top">
        <span>{t("activityBlock.eyebrow")}</span>
        <span className="connected-activity-status">{props.done ? t("activityBlock.done") : t("activityBlock.notDone")}</span>
      </div>
      <h2 id={headingId}>{run?.mode === "run" ? <span {...courseContentAttributes()}>{run.title}</span> : t("activityBlock.title")}</h2>
      {error && <Notice error>{t("activityBlock.openFailed")}</Notice>}
      {!run && !error && <p>{t("activityBlock.opening")}</p>}
      {run?.mode === "fallback" && (
        <Notice>
          {t("activityBlock.fallback", { kind: run.fallback.kind })}
        </Notice>
      )}
      {run?.mode === "run" && (
        <>
          <p className="connected-activity-alternative" {...courseContentAttributes()}>{run.accessibility.textAlternative}</p>
          {run.execution === "declarative" ? <DeclarativeActivity {...props} run={run} /> : <SandboxedActivity {...props} run={run} />}
        </>
      )}
    </section>
  );
}

function DeclarativeActivity(props: ActivityBlockProps & { run: ActivityRun }) {
  const t = useT();
  const { run, client } = props;
  const config = declarativeConfiguration(run.configuration);
  const saved = (run.state?.values ?? {}) as Record<string, JsonValue>;
  const [values, setValues] = useState<Record<string, JsonValue>>(saved);
  const [drafts, setDrafts] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(saved).filter(([, v]) => typeof v === "number").map(([k, v]) => [k, String(v)])));
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const revision = useRef(run.stateRevision), chain = useRef<Promise<unknown>>(Promise.resolve());
  const pendingSave = useRef<{ timer: number; values: Record<string, JsonValue> } | null>(null);
  useEffect(() => () => { if (pendingSave.current) window.clearTimeout(pendingSave.current.timer); }, []);
  if (!config) return <Notice error>{t("activityBlock.contentInvalid")}</Notice>;
  const canSave = run.grantedCapabilities.includes("state.patch"), canSubmit = run.grantedCapabilities.includes("observation.emit");
  /** Saves once the learner pauses (not per keystroke), or right before submitting. */
  function save(next: Record<string, JsonValue>) {
    if (!canSave) return;
    if (pendingSave.current) window.clearTimeout(pendingSave.current.timer);
    pendingSave.current = { values: next, timer: window.setTimeout(flush, SAVE_PAUSE_MS) };
  }
  function flush() {
    const pending = pendingSave.current;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pendingSave.current = null;
    const next = pending.values;
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
    if (missing.length) { setMessage({ text: t("activityBlock.partsLeft", { count: missing.length }), error: true }); return; }
    setBusy(true);
    try {
      flush();
      await chain.current;
      const result = await client.call<ObservationResult>(props.enrollmentId, run.instanceId, "observation.emit", { observation: { kind: "submitted", values } });
      setMessage({ text: resultText(result, t), error: result.evaluation.status === "unavailable" });
      if (result.satisfied && !props.done) props.onChanged();
    } catch (error) {
      const code = (error as { code?: string }).code;
      setMessage({ text: code === "ACTIVITY_RATE_LIMITED" ? t("activityBlock.error.ACTIVITY_RATE_LIMITED") : t("activityBlock.error.sendFailed"), error: true });
    } finally { setBusy(false); }
  }
  return (
    <form className="connected-activity-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <p {...courseContentAttributes()}>{config.prompt}</p>
      {config.controls.map((control) => {
        if (control.kind === "number") {
          return (
            <Field key={control.id} label={t("activityBlock.numberControl", { label: control.label, min: control.min, max: control.max })} value={drafts[control.id] ?? ""} inputMode="decimal" editable={!props.disabled && !busy}
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
              <legend {...courseContentAttributes()}>{control.label}</legend>
              <ChoiceList label={control.label} options={control.options} value={typeof values[control.id] === "string" ? (values[control.id] as string) : ""} onChange={(id) => update(control.id, id)} disabled={props.disabled || busy} />
            </fieldset>
          );
        return (
          <label key={control.id} className="connected-activity-toggle">
            <input type="checkbox" checked={values[control.id] === true} disabled={props.disabled || busy} onChange={(event) => update(control.id, event.currentTarget.checked)} />
            <span {...courseContentAttributes()}>{control.label}</span>
          </label>
        );
      })}
      {message && <Notice error={message.error}>{message.text}</Notice>}
      {canSubmit && <Button label={config.submitLabel ?? t("activityBlock.submit")} kind="primary" disabled={props.disabled || busy} onPress={() => void submit()} />}
    </form>
  );
}

function SandboxedActivity(props: ActivityBlockProps & { run: ActivityRun }) {
  const t = useT();
  const { run, client } = props;
  const frame = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<"starting" | "ready" | "stopped">("starting");
  const [notice, setNotice] = useState<"timedOut" | "leftFrame" | null>(null);
  const onChanged = useRef(props.onChanged), done = useRef(props.done);
  onChanged.current = props.onChanged;
  done.current = props.done;
  const url = run.frameUrl && FRAME_PATH.test(run.frameUrl) ? run.frameUrl : null;
  useEffect(() => {
    const element = frame.current;
    if (!element || !url) return;
    let loads = 0, port: MessagePort | null = null;
    const stop = (text: "timedOut" | "leftFrame") => { port?.close(); port = null; setStatus("stopped"); setNotice(text); };
    const timer = window.setTimeout(() => { if (!broker.ready) stop("timedOut"); },
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
    // A fresh nonce per frame load, in the URL fragment of Core's frame document. Its bootstrap says
    // hello with it; the port goes once, to that window, only in answer to that hello.
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[b & 63]).join("");
    let sent = false;
    const onHello = (event: MessageEvent) => {
      if (sent || loads > 1 || event.source !== element.contentWindow || !event.source) return;
      const data = event.data as { type?: unknown; nonce?: unknown } | null;
      if (!data || data.type !== "course-activity-hello" || data.nonce !== nonce) return;
      sent = true;
      const channel = new MessageChannel();
      port = channel.port1;
      port.onmessage = (message) => broker.handle(message.data);
      const context = { activityId: run.activityId, target: run.target, grantedCapabilities: run.grantedCapabilities, configuration: run.configuration,
        state: run.grantedCapabilities.includes("state.read") ? run.state : null, stateRevision: run.stateRevision };
      // The frame has an opaque origin, so "*" is the only possible target; the message carries no secrets.
      (event.source as Window).postMessage({ type: "course-activity-init", nonce, context }, "*", [channel.port2]);
    };
    const onLoad = () => {
      loads++;
      // The frame navigated itself away from Core's document: whatever is there now gets nothing.
      if (loads > 1) stop("leftFrame");
    };
    window.addEventListener("message", onHello);
    element.addEventListener("load", onLoad);
    // Navigate only once the listeners are in place, so neither the hello nor the first load is missed.
    element.src = `${url}#${nonce}`;
    return () => { window.removeEventListener("message", onHello); element.removeEventListener("load", onLoad); window.clearTimeout(timer); port?.close(); };
  }, [url, run, client, props.enrollmentId]);
  if (!url) return <Notice error>{t("activityBlock.frameInvalid")}</Notice>;
  return (
    <div className="connected-activity-frame-wrap">
      {status !== "stopped" && (
        <iframe ref={frame} className="connected-activity-frame" sandbox={ACTIVITY_FRAME_SANDBOX} title={t("activityBlock.frameTitle", { title: run.title })}
          referrerPolicy="no-referrer" allow="" data-testid="activity-frame" />
      )}
      {status === "starting" && <p className="connected-input-hint">{t("activityBlock.starting")}</p>}
      {notice && <Notice error>{t(`activityBlock.stopped.${notice}`)}</Notice>}
    </div>
  );
}
