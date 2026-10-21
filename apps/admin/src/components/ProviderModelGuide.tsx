import { useEffect, useRef, useState } from "react";
import type {
  ProviderSetup,
  ProviderSetupPort,
  ModelInspection,
  ModelPreview,
} from "../domain/providerSetup";
import { trimKey } from "../domain/providerSetup";
import { AdminError, errorMessage } from "../domain/errors";
import { Button, Field, Notice } from "./ui";
import { randomId } from "../domain/webCrypto";
import {
  keyReasons,
  providerSetupText as text,
  reasonMessage,
} from "../text/providerSetup";
interface Props {
  workspaceId: string;
  setup: ProviderSetup;
  api: ProviderSetupPort;
  disabled: boolean;
  /** Adds a connection of `kind` whose key is `key` (already trimmed). */
  onConnection: (kind: string, key: string) => void;
  /** Replaces the stored key of an existing connection. */
  onReplaceKey?: (adapterId: string, key: string) => void;
  onDraft: (preview: ModelPreview) => void;
}
/**
 * A key field with "Test key". The typed key stays in this component's memory: it is sent
 * once to the test endpoint (never stored there) and to `onSave`. Saving an untested key is
 * allowed, with a warning.
 */
function KeyEntry({
  id,
  label,
  kind,
  workspaceId,
  api,
  disabled,
  saveLabel,
  onSave,
}: {
  id: string;
  label: string;
  kind: string;
  workspaceId: string;
  api: ProviderSetupPort;
  disabled: boolean;
  saveLabel: string;
  onSave: (key: string) => void;
}) {
  const [key, setKey] = useState(""),
    [testing, setTesting] = useState(false),
    [result, setResult] = useState<{
      tested: string;
      ok: boolean;
      message: string;
    }>(),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const typed = trimKey(key),
    // A result belongs to the exact provider and key it tested.
    current = result?.tested === kind + "\0" + typed ? result : undefined;
  async function test() {
    if (!api.testKey || !typed || testing) return;
    const tested = kind + "\0" + typed;
    setTesting(true);
    setResult(undefined);
    try {
      const outcome = await api.testKey(workspaceId, { kind, key: typed });
      if (!alive.current) return;
      setResult(
        outcome.outcome === "ok"
          ? {
              tested,
              ok: true,
              message: text.keyWorks(
                outcome.modelCount ?? 0,
                !!outcome.truncated,
              ),
            }
          : {
              tested,
              ok: false,
              message:
                reasonMessage(outcome.outcome) ??
                reasonMessage("PROVIDER_METADATA_UNAVAILABLE")!,
            },
      );
    } catch (e) {
      if (!alive.current) return;
      setResult({
        tested,
        ok: false,
        message:
          (e instanceof AdminError && reasonMessage(e.reason)) ||
          (e instanceof AdminError && e.code !== "unavailable"
            ? errorMessage(e)
            : text.testIncomplete),
      });
    } finally {
      if (alive.current) setTesting(false);
    }
  }
  return (
    <>
      <Field label={label} htmlFor={id} hint={text.keyHint}>
        <input
          id={id}
          type="password"
          autoComplete="new-password"
          maxLength={8192}
          value={key}
          disabled={disabled}
          aria-describedby={id + "-hint"}
          onChange={(e) => setKey(e.target.value)}
        />
      </Field>
      <div className="tag-row">
        {api.testKey && (
          <Button
            disabled={disabled || testing || !kind || !typed}
            onClick={() => void test()}
          >
            {testing ? text.testingKey : text.testKey}
          </Button>
        )}
        <Button
          disabled={disabled || testing || !kind || !typed}
          onClick={() => onSave(typed)}
        >
          {saveLabel}
        </Button>
      </div>
      {current && (
        <Notice tone={current.ok ? "green" : "red"}>{current.message}</Notice>
      )}
      {typed && !testing && !current?.ok && api.testKey && (
        <Notice tone="gold">{text.untestedWarning}</Notice>
      )}
    </>
  );
}
function connections(value: unknown): { id: string; kind: string }[] {
  if (
    !value ||
    typeof value !== "object" ||
    !("adapters" in value) ||
    !Array.isArray(value.adapters)
  )
    return [];
  return value.adapters
    .filter((v) => v && typeof v.id === "string" && typeof v.kind === "string")
    .map((v) => ({ id: v.id, kind: v.kind }));
}
const roles = [
  "companion",
  "supervisor",
  "research",
  "reviewer",
  "media",
] as const;
type RoleMethods = NonNullable<
  ProviderSetup["metadataKinds"][number]["roleMethods"]
>;
/** Older servers report no per-role methods; they only offered the Google guide. */
const legacyMethods: RoleMethods = {
  companion: "generateContent",
  supervisor: "generateContent",
  research: "generateContent",
  reviewer: "generateContent",
  media: { image: "generateContent", video: "predictLongRunning" },
};
export function ProviderModelGuide({
  workspaceId,
  setup,
  api,
  disabled,
  onConnection,
  onReplaceKey,
  onDraft,
}: Props) {
  const available = setup.metadataKinds,
    existing = connections(setup.configuration),
    [kind, setKind] = useState(available[0]?.kind ?? ""),
    // The newest connection first: after adding one, it is the one to inspect.
    [adapterId, setAdapterId] = useState(existing.at(-1)?.id ?? ""),
    [inspection, setInspection] = useState<ModelInspection>(),
    [preview, setPreview] = useState<ModelPreview>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [declared, setDeclared] = useState(false),
    [selection, setSelection] = useState<Record<string, string>>({
      companion: "keep",
      supervisor: "keep",
      research: "keep",
      reviewer: "keep",
      media: "keep",
    }),
    [mediaKind, setMediaKind] = useState<"image" | "video">("image"),
    [duration, setDuration] = useState("4"),
    [ratio, setRatio] = useState("16:9"),
    [resolution, setResolution] = useState("720p"),
    [hosts, setHosts] = useState("");
  const pending = useRef<{
      expectedRevision: number;
      idempotencyKey: string;
      adapterId: string;
    } | null>(null),
    active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      pending.current = null;
    };
  }, []);
  useEffect(() => {
    setInspection(undefined);
    setPreview(undefined);
    pending.current = null;
    setAdapterId(existing.at(-1)?.id ?? "");
    setDeclared(false);
    setSelection({
      companion: "keep",
      supervisor: "keep",
      research: "keep",
      reviewer: "keep",
      media: "keep",
    });
  }, [setup.revision]);
  function resetAdapter(id: string) {
    setAdapterId(id);
    setInspection(undefined);
    setPreview(undefined);
    pending.current = null;
    setDeclared(false);
    setSelection({
      companion: "keep",
      supervisor: "keep",
      research: "keep",
      reviewer: "keep",
      media: "keep",
    });
  }
  async function inspect() {
    if (!api.inspectModels || !adapterId || busy) return;
    setBusy(true);
    setError("");
    pending.current ??= {
      expectedRevision: setup.revision,
      idempotencyKey: randomId(),
      adapterId,
    };
    try {
      const result = await api.inspectModels(workspaceId, pending.current);
      if (!active.current) return;
      setInspection(result);
      if (result.state === "failed") {
        pending.current = null;
        setError(reasonMessage(result.reason) ?? text.inspectionFailed);
      } else if (result.state === "complete") pending.current = null;
    } catch (e) {
      if (!active.current) return;
      // A definite refusal carries its reason; only an unanswered request is unconfirmed.
      const refused = e instanceof AdminError && reasonMessage(e.reason);
      if (refused) pending.current = null;
      setError(
        refused ||
          "Inspection is unconfirmed. Retry inspection to check the same request.",
      );
    } finally {
      if (active.current) setBusy(false);
    }
  }
  async function prepare() {
    if (!api.previewModels || !inspection?.result || !declared) return;
    setBusy(true);
    setError("");
    const assignments: Record<string, unknown> = {};
    for (const role of roles) {
      const value = selection[role];
      if (value === "keep" || (role === "media" && !mediaOffered)) continue;
      if (value === "disable") {
        assignments[role] = null;
        continue;
      }
      assignments[role] =
        role === "media"
          ? {
              remoteModel: value,
              kind: mediaKind,
              ...(mediaKind === "video"
                ? {
                    durationSeconds: Number(duration),
                    aspectRatio: ratio,
                    resolution,
                    downloadHosts: hosts
                      .split(",")
                      .map((v) => v.trim())
                      .filter(Boolean),
                  }
                : {}),
            }
          : value;
    }
    try {
      const result = await api.previewModels(workspaceId, {
        expectedRevision: setup.revision,
        inspectionId: inspection.id,
        assignments,
      });
      if (active.current) setPreview(result);
    } catch {
      if (active.current)
        setError(
          "The selection could not be prepared. Check supported methods, token limits and declared video parameters; refresh if settings changed.",
        );
    } finally {
      if (active.current) setBusy(false);
    }
  }
  const blocked = disabled || busy,
    guided = existing.find((a) => a.id === adapterId),
    kindInfo = available.find((a) => a.kind === guided?.kind),
    canGuide = kindInfo?.guided,
    methods = kindInfo?.roleMethods ?? legacyMethods,
    mediaOffered = methods.media !== null,
    shownRoles = roles.filter((role) => role !== "media" || mediaOffered);
  return (
    <section className="stack" aria-label="Guided model setup">
      <h3>1. Add a connection</h3>
      <p>
        Store a key for an installed provider. This step grants no spending
        allowance and does not make a model call.
      </p>
      <Field label="Installed provider" htmlFor="guided-provider">
        <select
          id="guided-provider"
          value={kind}
          disabled={blocked}
          onChange={(e) => setKind(e.target.value)}
        >
          {available.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.label}
            </option>
          ))}
        </select>
      </Field>
      <KeyEntry
        key={setup.revision}
        id="guided-key"
        label="API key for new connection"
        kind={kind}
        workspaceId={workspaceId}
        api={api}
        disabled={blocked}
        saveLabel="Save new connection"
        onSave={(key) => onConnection(kind, key)}
      />
      {api.testKey && <p>{text.testExplanation}</p>}
      {!!existing.length && <p>{text.savedKeyCheck}</p>}
      {!!existing.length && (
        <>
          <h3>2. Inspect available models</h3>
          <p>
            Read provider metadata using the saved key. This requests no
            generation and sends no learner history. Metadata does not verify a
            model's teaching or tool capabilities.
          </p>
          <Field label="Connection to inspect" htmlFor="guided-connection">
            <select
              id="guided-connection"
              disabled={blocked || !!pending.current}
              value={adapterId}
              onChange={(e) => resetAdapter(e.target.value)}
            >
              {existing.map((c) => (
                <option key={c.id} value={c.id}>
                  {available.find((k) => k.kind === c.kind)?.label ?? c.kind} ·{" "}
                  {c.id}
                </option>
              ))}
            </select>
          </Field>
          <Button
            disabled={blocked || !adapterId}
            onClick={() => void inspect()}
          >
            {pending.current
              ? "Retry metadata inspection"
              : "Inspect model metadata"}
          </Button>
        </>
      )}
      {error && <Notice tone="red">{error}</Notice>}
      {onReplaceKey &&
        guided &&
        inspection?.state === "failed" &&
        keyReasons.has(inspection.reason ?? "") && (
          <section className="stack" aria-label={text.replaceKeyHeading}>
            <h4>{text.replaceKeyHeading}</h4>
            <KeyEntry
              key={setup.revision + ":" + guided.id}
              id="guided-replace-key"
              label={text.replaceKeyLabel(guided.id)}
              kind={guided.kind}
              workspaceId={workspaceId}
              api={api}
              disabled={blocked}
              saveLabel={text.replaceKeySave}
              onSave={(key) => onReplaceKey(guided.id, key)}
            />
          </section>
        )}
      {inspection?.state === "in_flight" && (
        <Notice tone="gold">
          The existing inspection is still running. Retry later to read its
          receipt.
        </Notice>
      )}
      {inspection?.result && (
        <>
          <Notice tone="blue">
            Inspected {inspection.result.models.length} models across{" "}
            {inspection.result.pages} pages
            {inspection.result.truncated
              ? " · catalogue truncated at the host limit"
              : ""}
            . No generation was requested; live behavior remains unverified.
          </Notice>
          {!canGuide ? (
            <p>
              This adapter provides metadata. Use advanced JSON for its role
              configuration until its guided builder is installed.
            </p>
          ) : (
            <>
              <h3>3. Choose roles</h3>
              <p>
                Keep an existing role, disable it, or select a model whose
                reported API method matches the adapter. Specialized
                capabilities are declarations that still need live testing.
              </p>
              {shownRoles.map((role) => {
                const method =
                  role === "media"
                    ? mediaKind === "video"
                      ? methods.media!.video
                      : methods.media!.image
                    : methods[role];
                return (
                  <Field
                    key={role}
                    label={
                      role === "reviewer"
                        ? "reviewer drafts model (written answers)"
                        : `${role} model`
                    }
                    htmlFor={"guided-role-" + role}
                  >
                    <select
                      id={"guided-role-" + role}
                      disabled={blocked}
                      value={selection[role]}
                      onChange={(e) => {
                        setSelection({ ...selection, [role]: e.target.value });
                        setPreview(undefined);
                      }}
                    >
                      <option value="keep">Keep current role</option>
                      <option value="disable">Disable role</option>
                      {inspection
                        .result!.models.filter((m) =>
                          m.methods.includes(method),
                        )
                        .map((m) => (
                          <option key={m.remoteModel} value={m.remoteModel}>
                            {m.displayName} · {m.remoteModel}
                          </option>
                        ))}
                    </select>
                  </Field>
                );
              })}
              {!mediaOffered && (
                <p>
                  {kindInfo?.label ?? "This provider"} offers no image or video
                  generation. The media role keeps its current connection.
                </p>
              )}
              {mediaOffered && (
                <Field label="Media output kind" htmlFor="guided-media-kind">
                  <select
                    id="guided-media-kind"
                    value={mediaKind}
                    disabled={blocked}
                    onChange={(e) => {
                      setMediaKind(e.target.value as "image" | "video");
                      setSelection({ ...selection, media: "keep" });
                      setPreview(undefined);
                    }}
                  >
                    <option value="image">Image</option>
                    <option value="video">Short video</option>
                  </select>
                </Field>
              )}
              {mediaOffered && mediaKind === "video" && (
                <>
                  <p>
                    Declare parameters supported by your chosen video model.
                    Metadata method support alone does not confirm these
                    settings.
                  </p>
                  <div className="two-column">
                    <Field
                      label="Declared video duration (seconds)"
                      htmlFor="guided-duration"
                    >
                      <input
                        id="guided-duration"
                        inputMode="numeric"
                        disabled={blocked}
                        value={duration}
                        onChange={(e) => {
                          setDuration(e.target.value);
                          setPreview(undefined);
                        }}
                      />
                    </Field>
                    <Field
                      label="Declared video aspect ratio"
                      htmlFor="guided-ratio"
                    >
                      <input
                        id="guided-ratio"
                        disabled={blocked}
                        value={ratio}
                        onChange={(e) => {
                          setRatio(e.target.value);
                          setPreview(undefined);
                        }}
                      />
                    </Field>
                  </div>
                  <Field
                    label="Declared video resolution"
                    htmlFor="guided-resolution"
                  >
                    <input
                      id="guided-resolution"
                      disabled={blocked}
                      value={resolution}
                      onChange={(e) => {
                        setResolution(e.target.value);
                        setPreview(undefined);
                      }}
                    />
                  </Field>
                  <Field
                    label="Approved video download hosts, comma separated"
                    htmlFor="guided-hosts"
                  >
                    <input
                      id="guided-hosts"
                      disabled={blocked}
                      value={hosts}
                      onChange={(e) => {
                        setHosts(e.target.value);
                        setPreview(undefined);
                      }}
                    />
                  </Field>
                </>
              )}
              <label>
                <input
                  type="checkbox"
                  checked={declared}
                  disabled={blocked}
                  onChange={(e) => {
                    setDeclared(e.target.checked);
                    setPreview(undefined);
                  }}
                />{" "}
                I declare these roles and parameters; metadata inspection is not
                live verification.
              </label>
              <Button
                disabled={blocked || !declared}
                onClick={() => void prepare()}
              >
                Review model configuration
              </Button>
              {preview && (
                <Notice tone="blue">
                  <p>
                    Required conservative reservation:{" "}
                    {preview.minimumTokens.toLocaleString()} tokens per job.
                    This changes no cost allowance or paid-work budget.
                  </p>
                  <Button disabled={blocked} onClick={() => onDraft(preview)}>
                    Use draft and reserve{" "}
                    {preview.minimumTokens.toLocaleString()} tokens
                  </Button>
                  <p>
                    Then use Save settings below. Live behavior is still
                    unverified.
                  </p>
                </Notice>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
