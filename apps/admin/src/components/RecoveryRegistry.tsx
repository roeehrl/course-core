import { useEffect, useState } from "react";
import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import { Button, Card, Field, Notice, TechnicalDetails } from "./ui";
import { useI18n, type MessageKey } from "../i18n";
import { CopyText } from "./CopyText";

export function RecoveryRegistry({
  data,
  client,
}: {
  data: CourseWorkspace;
  client: AdminClient;
}) {
  const i18n = useI18n(),
    t = i18n.t;
  // A release's state in words ("published", "פורסם"), never the raw code.
  const stateName = (state: string) => {
    const key = `ui.status.${state}` as MessageKey;
    return i18n.has(key) ? t(key) : state.replaceAll("_", " ");
  };
  const [releaseId, setReleaseId] = useState(data.releases[0]?.id ?? ""),
    [draft, setDraft] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [runtime, setRuntime] =
      useState<
        Awaited<ReturnType<NonNullable<AdminClient["adaptationRuntime"]>>>
      >(),
    [registry, setRegistry] =
      useState<
        Awaited<ReturnType<NonNullable<AdminClient["adaptationRegistry"]>>>
      >();
  const allowed =
    client.mode === "connected" &&
    ["owner", "admin"].includes(data.role ?? "") &&
    Boolean(
      client.adaptationRuntime &&
      client.adaptationRegistry &&
      client.approveAdaptationRegistry,
    );
  async function refresh() {
    if (!allowed || !releaseId) return;
    setBusy(true);
    setError("");
    try {
      const [installed, state] = await Promise.all([
        client.adaptationRuntime!(),
        client.adaptationRegistry!(releaseId),
      ]);
      setRuntime(installed);
      setRegistry(state);
    } catch {
      setError(t("recoveryRegistry.error.load"));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    setRegistry(undefined);
    setBusy(true);
    if (!allowed || !releaseId) {
      setBusy(false);
      return;
    }
    Promise.all([
      client.adaptationRuntime!(),
      client.adaptationRegistry!(releaseId),
    ])
      .then(([r, s]) => {
        if (active) {
          setRuntime(r);
          setRegistry(s);
          setError("");
        }
      })
      .catch(() => {
        if (active) setError(t("recoveryRegistry.error.loadShort"));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [client, releaseId, allowed]);
  async function approve() {
    if (!registry || !allowed) return;
    let parsed: unknown;
    try {
      if (draft.length > 1500000) throw new Error();
      parsed = JSON.parse(draft);
    } catch {
      setError(t("recoveryRegistry.error.json"));
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const receipt = await client.approveAdaptationRegistry!(
        releaseId,
        registry.registryRevision,
        parsed,
      );
      setRegistry({
        ...registry,
        registryRevision: receipt.registryRevision,
        configured: true,
      });
      setNotice(t("recoveryRegistry.approved"));
    } catch {
      setError(t("recoveryRegistry.error.approve"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title={t("recoveryRegistry.title")}>
      <p>{t("recoveryRegistry.intro")}</p>
      {!allowed ? (
        <Notice tone="gold">{t("recoveryRegistry.notAllowed")}</Notice>
      ) : (
        <div className="page-stack">
          <Field
            label={t("recoveryRegistry.release")}
            htmlFor="recovery-registry-release"
          >
            <select
              id="recovery-registry-release"
              value={releaseId}
              disabled={busy}
              onChange={(e) => {
                setReleaseId(e.target.value);
                setNotice("");
              }}
            >
              {data.releases.map((r) => (
                <option key={r.id} value={r.id}>
                  {t("recoveryRegistry.releaseOption", {
                    version: r.version,
                    state: stateName(r.state),
                  })}
                </option>
              ))}
            </select>
          </Field>
          {runtime && (
            <div>
              <h3>{t("recoveryRegistry.installed")}</h3>
              {runtime.adapters.length ? (
                <ul className="creator-list">
                  {runtime.adapters.map((a) => (
                    <li key={a.id}>
                      <span>
                        <bdi className="mono">{a.id}</bdi>
                        <small>
                          <bdi>{a.kind}</bdi>
                        </small>
                      </span>
                      {/* The implementation's fingerprint is for comparing with the
                          author's, not for reading: copy it. */}
                      <CopyText
                        value={a.implementationDigest}
                        label={t("recoveryRegistry.copyDigest")}
                        copiedLabel={t("recoveryRegistry.copied")}
                        accessibleLabel={t("recoveryRegistry.copyDigestFor", {
                          creator: a.id,
                        })}
                      />
                    </li>
                  ))}
                </ul>
              ) : (
                <Notice tone="gold">{t("recoveryRegistry.noCreators")}</Notice>
              )}
            </div>
          )}
          {registry && (
            <p>
              {t("recoveryRegistry.revision", {
                revision: registry.registryRevision,
                state: registry.configured ? "approved" : "pending",
              })}
            </p>
          )}
          {error && <Notice tone="red">{error}</Notice>}
          {notice && <Notice tone="green">{notice}</Notice>}
          <div className="button-row">
            <Button
              type="button"
              disabled={busy}
              onClick={() => void refresh()}
            >
              {t("recoveryRegistry.refresh")}
            </Button>
          </div>
          {/* Approving a new registry is a developer task (the course author supplies the JSON):
              folded away, and open only while this version has no approved registry. */}
          <TechnicalDetails
            summary={t("recoveryRegistry.advanced")}
            open={registry ? !registry.configured : false}
          >
            <div className="stack">
              <p>{t("recoveryRegistry.advancedIntro")}</p>
              <Field
                label={t("recoveryRegistry.configuration")}
                htmlFor="recovery-registry-configuration"
                hint={t("recoveryRegistry.configurationHint")}
              >
                <textarea
                  id="recovery-registry-configuration"
                  aria-describedby="recovery-registry-configuration-hint"
                  dir="ltr"
                  rows={10}
                  value={draft}
                  disabled={busy}
                  placeholder={t("recoveryRegistry.placeholder")}
                  onChange={(e) => setDraft(e.target.value)}
                  spellCheck={false}
                />
              </Field>
              <Button
                type="button"
                kind={draft.trim() ? "primary" : "secondary"}
                reason={
                  !busy && registry && runtime?.adapters.length && !draft.trim()
                    ? t("recoveryRegistry.reason.empty")
                    : ""
                }
                disabled={
                  busy ||
                  !registry ||
                  !runtime?.adapters.length ||
                  !draft.trim()
                }
                onClick={() => void approve()}
              >
                {t("recoveryRegistry.approve")}
              </Button>
            </div>
          </TechnicalDetails>
        </div>
      )}
    </Card>
  );
}
