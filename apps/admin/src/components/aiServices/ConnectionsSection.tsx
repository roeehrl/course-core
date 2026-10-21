import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, ExternalLink, LoaderCircle } from "lucide-react";
import {
  AiServicesError,
  type Connection,
  type SectionState,
} from "../../domain/aiServices";
import { trimKey } from "../../domain/providerSetup";
import { analyzeKey, fixKeyCharacters } from "../../domain/keyCharacters";
import { KeyCharacters } from "./KeyCharacters";
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
  serviceName,
  unreachable,
  useAiText,
  useRequestKeys,
  type FieldError,
} from "./shared";

type Props = SectionProps & { state: SectionState; unsaved: boolean };
type Outcome =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; count: number; key: string }
  | { kind: "failed"; code: string; key: string };

export function ConnectionsSection(props: Props) {
  const { t } = useAiText();
  const { data } = props;
  const list = data.connections.connections;
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState("");
  const showForm = adding || !list.length;
  return (
    <Section
      id="connections"
      title={t("aiServices.section.connections")}
      state={props.state}
      unsaved={props.unsaved}
    >
      {notice && <Message tone="ok">{notice}</Message>}
      {list.length > 0 && (
        <ul className="ai-connections">
          {list.map((connection) => (
            <ConnectionRow
              key={connection.id}
              connection={connection}
              {...props}
              onDone={setNotice}
            />
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
            {t("aiServices.connect.addAnother")}
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
  kind,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Called after a paste or on leaving the field, only for a key with acceptable characters. */
  onCommit?: (value: string) => void;
  error?: string | undefined;
  hint?: React.ReactNode;
  disabled?: boolean;
  /** The service the key is for, to say where to copy it again. */
  kind?: string;
}) {
  const { t } = useAiText();
  const [visible, setVisible] = useState(false);
  const [fixed, setFixed] = useState(0);
  useEffect(() => {
    if (!value) {
      setVisible(false);
      setFixed(0);
    }
  }, [value]);
  // Checked on every change with the server's rule, so a refused character is named right away.
  const analysis = useMemo(() => analyzeKey(value), [value]);
  const commit = (next: string) => {
    if (!analyzeKey(next)) onCommit?.(next);
  };
  const charsId = `${id}-chars`;
  const shownError = analysis
    ? t("aiServices.keyChars.summary", { count: analysis.problems.length })
    : error;
  const describedBy = described(id, !!hint, shownError);
  return (
    <Field id={id} label={label} error={shownError} hint={hint}>
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
          onChange={(event) => {
            setFixed(0);
            onChange(event.target.value);
          }}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData("text");
            if (onCommit && pasted)
              setTimeout(
                () => commit((event.target as HTMLInputElement).value),
                0,
              );
          }}
          onBlur={(event) => commit(event.target.value)}
          {...describedBy}
          aria-describedby={
            analysis
              ? `${describedBy["aria-describedby"] ?? ""} ${charsId}`.trim()
              : describedBy["aria-describedby"]
          }
        />
        <button
          type="button"
          className="button quiet ai-eye"
          aria-pressed={visible}
          aria-label={
            visible
              ? t("aiServices.connect.hideKey")
              : t("aiServices.connect.showKey")
          }
          disabled={!value || disabled}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? (
            <EyeOff size={18} aria-hidden="true" />
          ) : (
            <Eye size={18} aria-hidden="true" />
          )}
        </button>
      </div>
      {analysis && (
        <KeyCharacters
          id={charsId}
          analysis={analysis}
          kind={kind}
          onFix={
            disabled
              ? undefined
              : () => {
                  const next = fixKeyCharacters(value);
                  setFixed(analysis.fixable);
                  onChange(next);
                  document.getElementById(id)?.focus();
                  commit(next);
                }
          }
        />
      )}
      {fixed > 0 && (
        <p className="ai-key-fixed" role="status">
          {t("aiServices.keyChars.fixed", { count: fixed })}
        </p>
      )}
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
}: Props & {
  cancellable: boolean;
  onCancel: () => void;
  onSaved: (message: string) => void;
}) {
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
  const service = serviceName(
    t,
    kind,
    kinds.find((k) => k.kind === kind)?.label,
  );
  const help = kinds.find((k) => k.kind === kind)?.keyHelpUrl;
  const keyId = `${base}-key`;
  useEffect(() => onDirty(!!key || !!name), [key, name, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  const latest = useRef(0);
  const keys = useRequestKeys();
  const inFlight = useRef<{ key: string; promise: Promise<Outcome> }>(
    undefined,
  );
  const badChars = !!analyzeKey(key);
  async function test(value: string): Promise<Outcome | null> {
    const clean = trimKey(value);
    if (!clean || analyzeKey(clean)) return null;
    if (
      (outcome.kind === "ok" || outcome.kind === "failed") &&
      outcome.key === clean
    )
      return outcome;
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
      const next: Outcome = {
        kind: "failed",
        code: error instanceof AiServicesError ? error.code : "UNAVAILABLE",
        key: clean,
      };
      if (run === latest.current) setOutcome(next);
      return next;
    }
  }
  async function save(skipTest = false) {
    setFailure("");
    const clean = trimKey(key);
    if (!clean) {
      setErrors([
        {
          field: keyId,
          message: t("aiServices.connect.errEmpty", { service }),
        },
      ]);
      return;
    }
    if (analyzeKey(clean)) return;
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
      const receipt = await port.addConnection(workspaceId, {
        ...request,
        idempotencyKey: keys.key(request),
      });
      keys.settle();
      setKey("");
      setName("");
      setOutcome({ kind: "idle" });
      onSaved(
        receipt.connection.keyEnding
          ? t("aiServices.connect.saved", {
              ending: receipt.connection.keyEnding,
            })
          : t("aiServices.connect.savedNoEnding"),
      );
      await reload();
    } catch (error) {
      keys.settle(error);
      if (
        error instanceof AiServicesError &&
        error.code.startsWith("PROVIDER_METADATA")
      ) {
        setOutcome({ kind: "failed", code: error.code, key: clean });
      } else setFailure(errorText(text, error, service));
    } finally {
      setSaving(false);
    }
  }
  const failedText =
    outcome.kind === "failed"
      ? (keyProblemText(text, outcome.code, service) ??
        t("aiServices.connect.errUnexpected"))
      : "";
  const keyError =
    errors.find((e) => e.field === keyId)?.message ??
    (outcome.kind === "failed" ? failedText : undefined);
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
      <h3 id={`${base}-title`}>{t("aiServices.connect.title")}</h3>
      <p>{t("aiServices.connect.intro")}</p>
      <ErrorSummary errors={errors} />
      {kinds.length > 1 && (
        <fieldset className="ai-choice">
          <legend>{t("aiServices.connect.serviceLabel")}</legend>
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
              {k.kind === "google" || k.kind === "anthropic"
                ? t(`aiServices.kind.${k.kind}`)
                : k.label}
            </label>
          ))}
        </fieldset>
      )}
      <KeyInput
        id={keyId}
        label={t("aiServices.connect.keyLabel")}
        value={key}
        error={keyError}
        disabled={saving}
        kind={kind}
        hint={
          help ? (
            <a href={help} target="_blank" rel="noreferrer noopener">
              {t(
                kind === "anthropic"
                  ? "aiServices.connect.keyHelp.anthropic"
                  : "aiServices.connect.keyHelp.google",
              )}
              <ExternalLink size={13} aria-hidden="true" />
              <span className="sr-only"> {t("aiServices.connect.newTab")}</span>
            </a>
          ) : undefined
        }
        onChange={(value) => {
          setKey(value);
          if (value) setErrors([]);
          if (outcome.kind !== "testing") setOutcome({ kind: "idle" });
        }}
        onCommit={(value) => void test(value)}
      />
      <div aria-live="polite" className="ai-live">
        {outcome.kind === "testing" && (
          <p className="ai-progress">
            <LoaderCircle size={16} className="spinner" aria-hidden="true" />{" "}
            {t("aiServices.connect.testing", { service })}
          </p>
        )}
        {outcome.kind === "ok" && (
          <Message tone="ok">
            {t("aiServices.connect.testOk", { service, count: outcome.count })}
          </Message>
        )}
      </div>
      {outcome.kind === "failed" && (
        <details className="ai-technical">
          <summary>{t("aiServices.connect.technical")}</summary>
          <p>
            {t("aiServices.connect.technicalCode")}:{" "}
            <Ltr className="mono">{outcome.code}</Ltr>
          </p>
        </details>
      )}
      {outcome.kind === "failed" && unreachable(outcome.code) && (
        <details className="ai-untested">
          <summary>
            {t("aiServices.connect.unreachableQuestion", { service })}
          </summary>
          <p>{t("aiServices.connect.saveUntestedWarn")}</p>
          <button
            type="button"
            className="button secondary"
            disabled={saving}
            onClick={() => void save(true)}
          >
            {t("aiServices.connect.saveUntested")}
          </button>
        </details>
      )}
      <Field
        id={`${base}-name`}
        label={t("aiServices.connect.nameLabel")}
        hint={t("aiServices.connect.nameHint")}
      >
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
          <button
            type="button"
            className="button secondary"
            onClick={onCancel}
            disabled={saving}
          >
            {t("aiServices.connect.cancel")}
          </button>
        )}
        <button
          type="submit"
          className="button primary"
          disabled={
            saving ||
            badChars ||
            (outcome.kind === "failed" && outcome.key === trimKey(key))
          }
          aria-describedby={badChars ? `${base}-blocked` : undefined}
        >
          {saving
            ? t("aiServices.connect.saving")
            : t("aiServices.connect.save")}
        </button>
      </div>
      {badChars && (
        <p id={`${base}-blocked`} className="ai-hint">
          {t("aiServices.keyChars.saveBlocked")}
        </p>
      )}
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
    connection.kind === "google" || connection.kind === "anthropic"
      ? t(`aiServices.kind.${connection.kind}`)
      : connection.label;
  const title = connection.name
    ? t("aiServices.row.connectionName", {
        service: kindName,
        name: connection.name,
      })
    : kindName;
  const [mode, setMode] = useState<"view" | "replace" | "remove">("view");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    tone: "ok" | "error";
    text: string;
  }>();
  const [key, setKey] = useState("");
  const [keyError, setKeyError] = useState<string>();
  const keys = useRequestKeys();
  const status = !connection.keyStored
    ? { tone: "bad", text: t("aiServices.row.keyMissing") }
    : connection.keyStatus === "working"
      ? { tone: "ok", text: t("aiServices.row.working") }
      : connection.keyStatus === "rejected"
        ? { tone: "bad", text: t("aiServices.row.rejected") }
        : connection.keyStatus === "unreachable"
          ? { tone: "warn", text: t("aiServices.row.unreachable", { service }) }
          : { tone: "warn", text: t("aiServices.row.notTested") };
  const reason = connection.keyReason
    ? keyProblemText(text, connection.keyReason, service)
    : undefined;
  async function testAgain() {
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await port.testConnection(workspaceId, connection.id);
      setMessage(
        result.outcome === "ok"
          ? { tone: "ok", text: t("aiServices.row.testResult.ok") }
          : {
              tone: "error",
              text:
                keyProblemText(text, result.outcome, service) ??
                t("aiServices.connect.errUnexpected"),
            },
      );
      await reload();
    } catch (error) {
      setMessage({ tone: "error", text: errorText(text, error, service) });
    } finally {
      setBusy(false);
    }
  }
  const badChars = !!analyzeKey(key);
  async function replace() {
    const clean = trimKey(key);
    if (!clean) {
      setKeyError(t("aiServices.connect.errEmpty", { service }));
      return;
    }
    if (analyzeKey(clean)) return;
    setKeyError(undefined);
    setBusy(true);
    try {
      const request = {
        expectedRevision: data.connections.revision,
        key: clean,
      };
      const receipt = await port.replaceKey(workspaceId, connection.id, {
        ...request,
        idempotencyKey: keys.key(request),
      });
      keys.settle();
      setKey("");
      setMode("view");
      onDone(
        receipt.connection.keyEnding
          ? t("aiServices.row.replaced", {
              ending: receipt.connection.keyEnding,
            })
          : t("aiServices.row.replacedNoEnding"),
      );
      await reload();
    } catch (error) {
      keys.settle(error);
      if (
        error instanceof AiServicesError &&
        error.code.startsWith("PROVIDER_")
      ) {
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
      onDone(t("aiServices.row.removed"));
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
                {t("aiServices.row.keyEnding", { ending: "" })}
                <Ltr className="mono">{connection.keyEnding}</Ltr>
              </>
            ) : connection.keyStored ? (
              t("aiServices.row.keySaved")
            ) : (
              t("aiServices.row.keyMissing")
            )}
          </span>
          <span>
            {connection.testedAt
              ? t("aiServices.row.tested", {
                  when: text.relative(connection.testedAt),
                })
              : t("aiServices.row.notTested")}
          </span>
          <span className={`ai-pill ${status.tone}`}>{status.text}</span>
        </p>
        <p className="ai-muted">
          {connection.usedByRoles.length
            ? t("aiServices.row.usedBy", { jobs })
            : t("aiServices.row.notUsed")}
        </p>
        {reason && connection.keyStatus !== "working" && (
          <Message tone="warn">{reason}</Message>
        )}
      </div>
      {message && (
        <Message tone={message.tone === "ok" ? "ok" : "error"}>
          {message.text}
        </Message>
      )}
      {mode === "replace" ? (
        <form
          className="ai-form ai-inline"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void replace();
          }}
        >
          <p>{t("aiServices.row.replaceNote")}</p>
          <KeyInput
            id={`${base}-replace`}
            label={t("aiServices.row.newKeyLabel", { name: title })}
            value={key}
            error={keyError}
            disabled={busy}
            kind={connection.kind}
            onChange={(value) => {
              setKey(value);
              setKeyError(undefined);
            }}
          />
          <div className="ai-actions">
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => setMode("view")}
            >
              {t("aiServices.connect.cancel")}
            </button>
            <button
              type="submit"
              className="button primary"
              disabled={busy || badChars}
              aria-describedby={badChars ? `${base}-blocked` : undefined}
            >
              {busy
                ? t("aiServices.connect.saving")
                : t("aiServices.row.replaceSave")}
            </button>
          </div>
          {badChars && (
            <p id={`${base}-blocked`} className="ai-hint">
              {t("aiServices.keyChars.saveBlocked")}
            </p>
          )}
        </form>
      ) : (
        <div className="ai-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => void testAgain()}
          >
            {busy ? t("aiServices.row.testing") : t("aiServices.row.testAgain")}
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
            {t("aiServices.row.replaceKey")}
          </button>
          <button
            type="button"
            className="button danger"
            disabled={busy}
            onClick={() => {
              setMessage(undefined);
              if (connection.usedByRoles.length)
                setMessage({
                  tone: "error",
                  text: t("aiServices.row.inUse", { jobs }),
                });
              else setMode("remove");
            }}
          >
            {t("aiServices.row.remove")}
          </button>
        </div>
      )}
      {mode === "remove" && (
        <Confirm
          title={t("aiServices.row.removeTitle")}
          body={t("aiServices.row.removeBody", { name: title })}
          confirm={t("aiServices.row.removeConfirm")}
          pending={busy}
          onCancel={() => setMode("view")}
          onConfirm={() => void remove()}
        />
      )}
    </li>
  );
}
