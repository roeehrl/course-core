import { useRef, useState } from "react";
import type { AdminClient } from "../domain/contracts";
import type {
  LearningPolicy,
  PolicyMigrationPreview,
  PolicyMigrationResult,
} from "../domain/policy";
import { Button, Dialog, ErrorState, Field, Notice } from "./ui";
import { ScopeQuotas } from "./PolicyDetails";
import { randomId } from "../domain/webCrypto";
import { useFormatters, useI18n } from "../i18n";

export function PolicyMigrationEditor({
  client,
  policy,
  onClose,
  onUpdated,
}: {
  client: AdminClient;
  policy: LearningPolicy;
  onClose: () => void;
  onUpdated: (result: PolicyMigrationResult) => void;
}) {
  const i18n = useI18n();
  const t = i18n.t;
  const { when } = useFormatters();
  const [source, setSource] = useState(
    JSON.stringify(
      policy.scopes.map(({ label: _label, ...scope }) => scope),
      null,
      2,
    ),
  );
  const [preview, setPreview] = useState<PolicyMigrationPreview>(),
    [error, setError] = useState<unknown>(),
    [syntax, setSyntax] = useState(""),
    [pending, setPending] = useState(false),
    [reviewed, setReviewed] = useState(false),
    [reason, setReason] = useState("");
  const busy = useRef(false),
    keys = useRef(new Map<string, string>());
  function change(value: string) {
    setSource(value);
    setPreview(undefined);
    setReviewed(false);
    setError(undefined);
    setSyntax("");
  }
  async function previewChange() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    setSyntax("");
    setPreview(undefined);
    setReviewed(false);
    try {
      const scopes: unknown = JSON.parse(source);
      if (!Array.isArray(scopes)) {
        setSyntax(t("policyMigrationEditor.syntax.array"));
        return;
      }
      const result = await client.previewPolicyChange!(
        policy.enrollmentId,
        scopes,
      );
      setPreview(result);
    } catch (cause) {
      if (cause instanceof SyntaxError)
        setSyntax(t("policyMigrationEditor.syntax.json"));
      else setError(cause);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  async function apply() {
    if (!preview || !reviewed || !reason.trim() || busy.current) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    const fingerprint = JSON.stringify([preview.previewId, reason]);
    let key = keys.current.get(fingerprint);
    if (!key) {
      key = randomId();
      keys.current.set(fingerprint, key);
    }
    try {
      const result = await client.migratePolicy!(
        policy.enrollmentId,
        {
          previewId: preview.previewId,
          previewDigest: preview.previewDigest,
          reason: reason.trim(),
        },
        { expectedRevision: preview.revision, idempotencyKey: key },
      );
      onUpdated(result);
      onClose();
    } catch (cause) {
      setError(cause);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <Dialog
      title={t("policyMigrationEditor.title")}
      onClose={onClose}
      pending={pending}
    >
      <Notice tone="gold">{t("policyMigrationEditor.notice")}</Notice>
      <Field
        label={t("policyMigrationEditor.source")}
        htmlFor="migration-source"
      >
        <textarea
          className="manifest-editor"
          id="migration-source"
          dir="ltr"
          value={source}
          onChange={(e) => change(e.target.value)}
          disabled={pending}
        />
      </Field>
      {syntax && <Notice tone="red">{syntax}</Notice>}
      {Boolean(error) && <ErrorState error={error} />}
      <Button onClick={() => void previewChange()} disabled={pending}>
        {pending
          ? t("policyMigrationEditor.validating")
          : t("policyMigrationEditor.compute")}
      </Button>
      {preview && (
        <div className="stack">
          <h3>{t("policyMigrationEditor.impact")}</h3>
          <small>
            {i18n.rich(
              "policyMigrationEditor.expires",
              {
                digest: preview.previewDigest,
                date: when(preview.expiresAt),
              },
              {
                id: (children, key) => (
                  <span key={key} className="mono" dir="ltr">
                    {children}
                  </span>
                ),
              },
            )}
          </small>
          <Notice tone="gold">
            {t("policyMigrationEditor.affected", {
              reserved: preview.affectedReservationIds.length,
              offers: preview.supersededOfferIds.length,
            })}
          </Notice>
          {preview.impacts.map((impact) => (
            <details key={impact.scopeId}>
              <summary>
                <bdi>
                  {policy.scopes.find((s) => s.scopeId === impact.scopeId)
                    ?.label ?? impact.scopeId}
                </bdi>
              </summary>
              <p>
                {t("policyMigrationEditor.effective", {
                  before: impact.before.effectiveDeadline
                    ? when(impact.before.effectiveDeadline)
                    : t("policyMigrationEditor.none"),
                  after: impact.after.effectiveDeadline
                    ? when(impact.after.effectiveDeadline)
                    : t("policyMigrationEditor.none"),
                })}
              </p>
              <h3>{t("policyMigrationEditor.currentEnvelope")}</h3>
              <ScopeQuotas
                quotas={impact.before.quotas}
                scopes={policy.scopes}
              />
              <h3>{t("policyMigrationEditor.proposedEnvelope")}</h3>
              <ScopeQuotas
                quotas={impact.after.quotas}
                scopes={policy.scopes}
              />
            </details>
          ))}
          <Field
            label={t("policyMigrationEditor.reason")}
            htmlFor="migration-reason"
          >
            <textarea
              id="migration-reason"
              dir="auto"
              maxLength={1000}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setReviewed(false);
              }}
              disabled={pending}
            />
          </Field>
          <label className="check-label">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(e) => setReviewed(e.target.checked)}
              disabled={pending}
            />
            {t("policyMigrationEditor.reviewed")}
          </label>
          <Button
            kind="primary"
            disabled={!reviewed || !reason.trim() || pending}
            onClick={() => void apply()}
          >
            {t("policyMigrationEditor.apply")}
          </Button>
        </div>
      )}
    </Dialog>
  );
}
