import { useEffect, useId, useRef, useState } from "react";
import { Eye, EyeOff, ExternalLink, LoaderCircle } from "lucide-react";
import { AiServicesError, type Connection, type SectionState } from "../../domain/aiServices";
import { trimKey } from "../../domain/providerSetup";
import type { SectionProps } from "./AiServicesPage";
import {
  Confirm,
  ErrorSummary,
  Field,
  Ltr,
  Message,
  Section,
  described,
  errorText,
  jobName,
  keyProblemText,
  newKey,
  relativeTime,
  serviceName,
  unreachable,
  useAiText,
  useRequestKeys,
  type FieldError,
} from "./shared";

type Props = SectionProps & { state: SectionState; unsaved: boolean };
type Outcome = { kind: "idle" } | { kind: "testing" } | { kind: "ok"; count: number; key: string } | { kind: "failed"; code: string; key: string };

export function ConnectionsSection(props: Props) {
  const { t } = useAiText();
  const { data } = props;
  const list = data.connections.connections;
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState("");
  const showForm = adding || !list.length;
  return (
    <Section id="connections" title={t("section.connections")} state={props.state} unsaved={props.unsaved}>
      {notice && <Message tone="ok">{notice}</Message>}
      {list.length > 0 && (
        <ul className="ai-connections">
          {list.map((connection) => (
            <ConnectionRow key={connection.id} connection={connection} {...props} onDone={setNotice} />
          ))}
        </ul>
      )}
      {showForm ? (
        <AddConnection
          {...props}
          cancellable={list.length > 0}
          onCancel={() => setAdding(false)}
          onSaved={(message) => {
            setAdding(false);
            setNotice(message);
          }}
        />
      ) : (
        <div className="ai-actions">
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              setNotice("");
              setAdding(true);
            }}
          >
            {t("connect.addAnother")}
          </button>
        </div>
      )}
    </Section>
  );
}

function KeyInput({
  id,
  label,
  value,
  onChange,
  onCommit,
  error,
  hint,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onCommit?: (value: string) => void;
  error?: string | undefined;
  hint?: React.ReactNode;
  disabled?: boolean;
}) {
  const { t } = useAiText();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!value) setVisible(false);
  }, [value]);
  return (
    <Field id={id} label={label} error={error} hint={hint}>
      <div className="ai-key-input">
        <input
          id={id}
          type={visible ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          dir="ltr"
          inputMode="text"
          maxLength={8192}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData("text");
            if (onCommit && pasted) setTimeout(() => onCommit((event.target as HTMLInputElement).value), 0);
          }}
          onBlur={(event) => onCommit?.(event.target.value)}
          {...described(id, !!hint, error)}
        />
        <button
          type="button"
          className="button quiet ai-eye"
          aria-pressed={visible}
          aria-label={visible ? t("connect.hideKey") : t("connect.showKey")}
          disabled={!value || disabled}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
        </button>
      </div>
    </Field>
  );
}

function AddConnection({
  workspaceId,
  port,
  data,
  reload,
  onDirty,
  cancellable,
  onCancel,
  onSaved,
}: Props & { cancellable: boolean; onCancel: () => void; onSaved: (message: string) => void }) {
  const text = useAiText();
  const { t } = text;
  const base = useId().replaceAll(":", "");
  const kinds = data.setup.metadataKinds.filter((k) => k.guided);
  const [kind, setKind] = useState(kinds[0]?.kind ?? "google");
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [failure, setFailure] = useState("");
  const [saving, setSaving] = useState(false);
  const service = serviceName(t, kind, kinds.find((k) => k.kind === kind)?.label);
  const help = kinds.find((k) => k.kind === kind)?.keyHelpUrl;
  const keyId = `${base}-key`;
  useEffect(() => onDirty(!!key || !!name), [key, name, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  const latest = useRef(0);
  const keys = useRequestKeys();
  const inFlight = useRef<{ key: string; promise: Promise<Outcome> }>(undefined);
  async function test(value: string): Promise<Outcome | null> {
    const clean = trimKey(value);
    if (!clean) return null;
    if ((outcome.kind === "ok" || outcome.kind === "failed") && outcome.key === clean) return outcome;
    // Save pressed while the same key is still being checked waits for that check.
    if (inFlight.current?.key === clean) return inFlight.current.promise;
    const promise = check(clean);
    inFlight.current = { key: clean, promise };
    try {
      return await promise;
    } finally {
      if (inFlight.current?.promise === promise) inFlight.current = undefined;
    }
  }
  async function check(clean: string): Promise<Outcome> {
    const run = ++latest.current;
    setOutcome({ kind: "testing" });
    setErrors([]);
    try {
      const result = await port.testKey(workspaceId, { kind, key: clean });
      const next: Outcome =
        result.outcome === "ok"
          ? { kind: "ok", count: result.modelCount ?? 0, key: clean }
          : { kind: "failed", code: result.outcome, key: clean };
      if (run === latest.current) setOutcome(next);
      return next;
    } catch (error) {
      const next: Outcome = { kind: "failed", code: error instanceof AiServicesError ? error.code : "UNAVAILABLE", key: clean };
      if (run === latest.current) setOutcome(next);
      return next;
    }
  }
  async function save(skipTest = false) {
    setFailure("");
    const clean = trimKey(key);
    if (!clean) {
      setErrors([{ field: keyId, message: t("connect.errEmpty", { service }) }]);
      return;
    }
    setErrors([]);
    setSaving(true);
    try {
      if (!skipTest) {
        const result = await test(key);
        if (!result || result.kind !== "ok") return;
      }
      const request = {
        expectedRevision: data.connections.revision,
        kind,
        key: clean,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(skipTest ? { skipTest: true } : {}),
      };
      const receipt = await port.addConnection(workspaceId, { ...request, idempotencyKey: keys.key(request) });
      keys.settle();
      setKey("");
      setName("");
      setOutcome({ kind: "idle" });
      onSaved(
        receipt.connection.keyEnding
          ? t("connect.saved", { ending: text.ltr(receipt.connection.keyEnding) })
          : t("connect.savedNoEnding"),
      );
      await reload();
    } catch (error) {
      keys.settle(error);
      if (error instanceof AiServicesError && error.code.startsWith("PROVIDER_METADATA")) {
        setOutcome({ kind: "failed", code: error.code, key: clean });
      } else setFailure(errorText(text, error, service));
    } finally {
      setSaving(false);
    }
  }
  const failedText =
    outcome.kind === "failed" ? (keyProblemText(text, outcome.code, service) ?? t("connect.errUnexpected")) : "";
  const keyError = errors.find((e) => e.field === keyId)?.message ?? (outcome.kind === "failed" ? failedText : undefined);
  return (
    <form
      className="ai-form"
      noValidate
      aria-labelledby={`${base}-title`}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h3 id={`${base}-title`}>{t("connect.title")}</h3>
      <p>{t("connect.intro")}</p>
      <ErrorSummary errors={errors} />
      {kinds.length > 1 && (
        <fieldset className="ai-choice">
          <legend>{t("connect.serviceLabel")}</legend>
          {kinds.map((k) => (
            <label key={k.kind}>
              <input
                type="radio"
                name={`${base}-kind`}
                value={k.kind}
                checked={kind === k.kind}
                onChange={() => {
                  setKind(k.kind);
                  setOutcome({ kind: "idle" });
                }}
              />
              {k.kind === "google" || k.kind === "anthropic" ? t(`kind.${k.kind}`) : k.label}
            </label>
          ))}
        </fieldset>
      )}
      <KeyInput
        id={keyId}
        label={t("connect.keyLabel")}
        value={key}
        error={keyError}
        disabled={saving}
        hint={
          help ? (
            <a href={help} target="_blank" rel="noreferrer noopener">
              {t(kind === "anthropic" ? "connect.keyHelp.anthropic" : "connect.keyHelp.google")}
              <ExternalLink size={13} aria-hidden="true" />
              <span className="sr-only"> {t("connect.newTab")}</span>
            </a>
          ) : undefined
        }
        onChange={(value) => {
          setKey(value);
          if (outcome.kind !== "testing") setOutcome({ kind: "idle" });
        }}
        onCommit={(value) => void test(value)}
      />
      <div aria-live="polite" className="ai-live">
        {outcome.kind === "testing" && (
          <p className="ai-progress">
            <LoaderCircle size={16} className="spinner" aria-hidden="true" /> {t("connect.testing", { service })}
          </p>
        )}
        {outcome.kind === "ok" && <Message tone="ok">{t("connect.testOk", { service, count: outcome.count })}</Message>}
      </div>
      {outcome.kind === "failed" && (
        <details className="ai-technical">
          <summary>{t("connect.technical")}</summary>
          <p>
            {t("connect.technicalCode")}: <Ltr className="mono">{outcome.code}</Ltr>
          </p>
        </details>
      )}
      {outcome.kind === "failed" && unreachable(outcome.code) && (
        <details className="ai-untested">
          <summary>{t("connect.unreachableQuestion", { service })}</summary>
          <p>{t("connect.saveUntestedWarn")}</p>
          <button type="button" className="button secondary" disabled={saving} onClick={() => void save(true)}>
            {t("connect.saveUntested")}
          </button>
        </details>
      )}
      <Field id={`${base}-name`} label={t("connect.nameLabel")} hint={t("connect.nameHint")}>
        <input
          id={`${base}-name`}
          dir="auto"
          maxLength={80}
          value={name}
          disabled={saving}
          onChange={(event) => setName(event.target.value)}
          {...described(`${base}-name`, true, undefined)}
        />
      </Field>
      {failure && <Message tone="error">{failure}</Message>}
      <div className="ai-actions">
        {cancellable && (
          <button type="button" className="button secondary" onClick={onCancel} disabled={saving}>
            {t("connect.cancel")}
          </button>
        )}
        <button
          type="submit"
          className="button primary"
          disabled={saving || (outcome.kind === "failed" && outcome.key === trimKey(key))}
        >
          {saving ? t("connect.saving") : t("connect.save")}
        </button>
      </div>
    </form>
  );
}

function ConnectionRow({
  connection,
  workspaceId,
  port,
  data,
  reload,
  onDone,
}: Props & { connection: Connection; onDone: (message: string) => void }) {
  const text = useAiText();
  const { t } = text;
  const base = useId().replaceAll(":", "");
  const service = serviceName(t, connection.kind, connection.label);
  const kindName =
    connection.kind === "google" || connection.kind === "anthropic" ? t(`kind.${connection.kind}`) : connection.label;
  const title = connection.name ? t("row.connectionName", { service: kindName, name: connection.name }) : kindName;
  const [mode, setMode] = useState<"view" | "replace" | "remove">("view");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string }>();
  const [key, setKey] = useState("");
  const [keyError, setKeyError] = useState<string>();
  const keys = useRequestKeys();
  const status =
    !connection.keyStored
      ? { tone: "bad", text: t("row.keyMissing") }
      : connection.keyStatus === "working"
        ? { tone: "ok", text: t("row.working") }
        : connection.keyStatus === "rejected"
          ? { tone: "bad", text: t("row.rejected") }
          : connection.keyStatus === "unreachable"
            ? { tone: "warn", text: t("row.unreachable", { service }) }
            : { tone: "warn", text: t("row.notTested") };
  const reason = connection.keyReason ? keyProblemText(text, connection.keyReason, service) : undefined;
  async function testAgain() {
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await port.testConnection(workspaceId, connection.id);
      setMessage(
        result.outcome === "ok"
          ? { tone: "ok", text: t("row.testResult.ok") }
          : { tone: "error", text: keyProblemText(text, result.outcome, service) ?? t("connect.errUnexpected") },
      );
      await reload();
    } catch (error) {
      setMessage({ tone: "error", text: errorText(text, error, service) });
    } finally {
      setBusy(false);
    }
  }
  async function replace() {
    const clean = trimKey(key);
    if (!clean) {
      setKeyError(t("connect.errEmpty", { service }));
      return;
    }
    setKeyError(undefined);
    setBusy(true);
    try {
      const request = { expectedRevision: data.connections.revision, key: clean };
      const receipt = await port.replaceKey(workspaceId, connection.id, { ...request, idempotencyKey: keys.key(request) });
      keys.settle();
      setKey("");
      setMode("view");
      onDone(
        receipt.connection.keyEnding
          ? t("row.replaced", { ending: text.ltr(receipt.connection.keyEnding) })
          : t("row.replacedNoEnding"),
      );
      await reload();
    } catch (error) {
      keys.settle(error);
      if (error instanceof AiServicesError && error.code.startsWith("PROVIDER_")) {
        const copy = keyProblemText(text, error.code, service);
        if (copy) {
          setKeyError(copy);
          return;
        }
      }
      setMessage({ tone: "error", text: errorText(text, error, service) });
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    try {
      await port.removeConnection(workspaceId, connection.id, {
        expectedRevision: data.connections.revision,
        idempotencyKey: newKey(),
      });
      setMode("view");
      onDone(t("row.removed"));
      await reload();
    } catch (error) {
      setMode("view");
      setMessage({ tone: "error", text: errorText(text, error, service) });
    } finally {
      setBusy(false);
    }
  }
  const jobs = text.list(connection.usedByRoles.map((r) => jobName(t, r)));
  return (
    <li className="ai-connection">
      <div className="ai-connection-main">
        <h3 dir="auto">{title}</h3>
        <p className="ai-facts">
          <span>
            {connection.keyEnding ? (
              <>
                {t("row.keyEnding", { ending: "" })}
                <Ltr className="mono">{connection.keyEnding}</Ltr>
              </>
            ) : connection.keyStored ? (
              t("row.keySaved")
            ) : (
              t("row.keyMissing")
            )}
          </span>
          <span>
            {connection.testedAt
              ? t("row.tested", { when: relativeTime(text.locale, connection.testedAt) })
              : t("row.notTested")}
          </span>
          <span className={`ai-pill ${status.tone}`}>{status.text}</span>
        </p>
        <p className="ai-muted">{connection.usedByRoles.length ? t("row.usedBy", { jobs }) : t("row.notUsed")}</p>
        {reason && connection.keyStatus !== "working" && <Message tone="warn">{reason}</Message>}
      </div>
      {message && <Message tone={message.tone === "ok" ? "ok" : "error"}>{message.text}</Message>}
      {mode === "replace" ? (
        <form
          className="ai-form ai-inline"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void replace();
          }}
        >
          <p>{t("row.replaceNote")}</p>
          <KeyInput
            id={`${base}-replace`}
            label={t("row.newKeyLabel", { name: title })}
            value={key}
            error={keyError}
            disabled={busy}
            onChange={(value) => {
              setKey(value);
              setKeyError(undefined);
            }}
          />
          <div className="ai-actions">
            <button type="button" className="button secondary" disabled={busy} onClick={() => setMode("view")}>
              {t("connect.cancel")}
            </button>
            <button type="submit" className="button primary" disabled={busy}>
              {busy ? t("connect.saving") : t("row.replaceSave")}
            </button>
          </div>
        </form>
      ) : (
        <div className="ai-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={() => void testAgain()}>
            {busy ? t("row.testing") : t("row.testAgain")}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => {
              setMessage(undefined);
              setMode("replace");
            }}
          >
            {t("row.replaceKey")}
          </button>
          <button
            type="button"
            className="button danger"
            disabled={busy}
            onClick={() => {
              setMessage(undefined);
              if (connection.usedByRoles.length) setMessage({ tone: "error", text: t("row.inUse", { jobs }) });
              else setMode("remove");
            }}
          >
            {t("row.remove")}
          </button>
        </div>
      )}
      {mode === "remove" && (
        <Confirm
          title={t("row.removeTitle")}
          body={t("row.removeBody", { name: title })}
          confirm={t("row.removeConfirm")}
          pending={busy}
          onCancel={() => setMode("view")}
          onConfirm={() => void remove()}
        />
      )}
    </li>
  );
}
