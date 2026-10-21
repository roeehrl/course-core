import { useEffect, useState } from "react";
import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import { Card, Notice } from "./ui";
import { useT } from "../i18n";

export function RecoveryRegistry({
  data,
  client,
}: {
  data: CourseWorkspace;
  client: AdminClient;
}) {
  const t = useT();
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
    <Card
      title={t("recoveryRegistry.title")}
      eyebrow={t("recoveryRegistry.eyebrow")}
    >
      <p>{t("recoveryRegistry.intro")}</p>
      {!allowed ? (
        <Notice tone="gold">{t("recoveryRegistry.notAllowed")}</Notice>
      ) : (
        <div className="page-stack">
          <label>
            {t("recoveryRegistry.release")}
            <select
              aria-label={t("recoveryRegistry.release")}
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
                    state: r.state,
                  })}
                </option>
              ))}
            </select>
          </label>
          {runtime && (
            <div>
              <h3>{t("recoveryRegistry.installed")}</h3>
              {runtime.adapters.length ? (
                runtime.adapters.map((a) => (
                  <p key={a.id}>
                    <strong dir="ltr">{a.id}</strong> ·{" "}
                    <span dir="ltr">{a.kind}</span>
                    <br />
                    <code dir="ltr" style={{ overflowWrap: "anywhere" }}>
                      {a.implementationDigest}
                    </code>
                  </p>
                ))
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
          <label>
            {t("recoveryRegistry.configuration")}
            <textarea
              aria-label={t("recoveryRegistry.configuration")}
              dir="ltr"
              rows={10}
              value={draft}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
            />
          </label>
          <small>{t("recoveryRegistry.configurationHint")}</small>
          {error && <Notice tone="red">{error}</Notice>}
          {notice && <Notice tone="green">{notice}</Notice>}
          <div className="button-row">
            <button
              type="button"
              disabled={busy}
              onClick={() => void refresh()}
            >
              {t("recoveryRegistry.refresh")}
            </button>
            <button
              type="button"
              disabled={
                busy || !registry || !runtime?.adapters.length || !draft.trim()
              }
              onClick={() => void approve()}
            >
              {t("recoveryRegistry.approve")}
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
