import { useEffect, useRef, useState } from "react";
import type {
  ProviderSetup,
  ProviderSetupPort,
  ModelInspection,
  ModelPreview,
} from "../domain/providerSetup";
import { Button, Field, Notice } from "./ui";
interface Props {
  workspaceId: string;
  setup: ProviderSetup;
  api: ProviderSetupPort;
  disabled: boolean;
  onConnection: (kind: string, key: string) => void;
  onDraft: (preview: ModelPreview) => void;
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
const roles = ["companion", "supervisor", "research", "media"] as const;
export function ProviderModelGuide({
  workspaceId,
  setup,
  api,
  disabled,
  onConnection,
  onDraft,
}: Props) {
  const available = setup.metadataKinds,
    existing = connections(setup.configuration),
    [kind, setKind] = useState(available[0]?.kind ?? ""),
    [key, setKey] = useState(""),
    [adapterId, setAdapterId] = useState(existing[0]?.id ?? ""),
    [inspection, setInspection] = useState<ModelInspection>(),
    [preview, setPreview] = useState<ModelPreview>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [declared, setDeclared] = useState(false),
    [selection, setSelection] = useState<Record<string, string>>({
      companion: "keep",
      supervisor: "keep",
      research: "keep",
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
    setKey("");
    setInspection(undefined);
    setPreview(undefined);
    pending.current = null;
    setAdapterId(existing[0]?.id ?? "");
    setDeclared(false);
    setSelection({
      companion: "keep",
      supervisor: "keep",
      research: "keep",
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
      media: "keep",
    });
  }
  async function inspect() {
    if (!api.inspectModels || !adapterId || busy) return;
    setBusy(true);
    setError("");
    pending.current ??= {
      expectedRevision: setup.revision,
      idempotencyKey: crypto.randomUUID(),
      adapterId,
    };
    try {
      const result = await api.inspectModels(workspaceId, pending.current);
      if (!active.current) return;
      setInspection(result);
      if (result.state === "failed") {
        pending.current = null;
        setError(
          "Metadata inspection failed or its scope changed. Check the saved connection and refresh before another inspection.",
        );
      } else if (result.state === "complete") pending.current = null;
    } catch {
      if (active.current)
        setError(
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
      if (value === "keep") continue;
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
    canGuide = available.find((a) => a.kind === guided?.kind)?.guided;
  return (
    <section className="stack" aria-label="Guided model setup">
      <h3>1. Add a connection</h3>
      <p>
        Store a key for an installed provider. This step grants no spending
        allowance and does not make a model call.
      </p>
      <div className="two-column">
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
        <Field label="API key for new connection" htmlFor="guided-key">
          <input
            id="guided-key"
            type="password"
            autoComplete="new-password"
            maxLength={8192}
            value={key}
            disabled={blocked}
            onChange={(e) => setKey(e.target.value)}
          />
        </Field>
      </div>
      <Button
        disabled={blocked || !kind || !key}
        onClick={() => onConnection(kind, key)}
      >
        Save new connection
      </Button>
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
              {roles.map((role) => {
                const method =
                  role === "media" && mediaKind === "video"
                    ? "predictLongRunning"
                    : "generateContent";
                return (
                  <Field
                    key={role}
                    label={`${role} model`}
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
              {mediaKind === "video" && (
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
