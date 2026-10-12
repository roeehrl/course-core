import { useRef, useState } from "react";
import type { AdminClient } from "../domain/contracts";
import type {
  LearningPolicy,
  PolicyMigrationPreview,
  PolicyMigrationResult,
} from "../domain/policy";
import { Button, Dialog, ErrorState, Field, Notice, when } from "./ui";
import { ScopeQuotas } from "./PolicyDetails";

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
        setSyntax("Expected an array of complete scope definitions.");
        return;
      }
      const result = await client.previewPolicyChange!(
        policy.enrollmentId,
        scopes,
      );
      setPreview(result);
    } catch (cause) {
      if (cause instanceof SyntaxError) setSyntax("Enter valid scope JSON.");
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
      key = crypto.randomUUID();
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
      title="Preview a policy migration"
      onClose={onClose}
      pending={pending}
    >
      <Notice tone="gold">
        This changes learning policy, not tool budgets. Existing
        anchors/windows, scope identities, pools, grants and ledger history must
        be preserved. The server computes concrete impacts before authorizing a
        migration.
      </Notice>
      <Field
        label="Proposed scope definitions (JSON)"
        htmlFor="migration-source"
      >
        <textarea
          className="manifest-editor"
          id="migration-source"
          value={source}
          onChange={(e) => change(e.target.value)}
          disabled={pending}
        />
      </Field>
      {syntax && <Notice tone="red">{syntax}</Notice>}
      {Boolean(error) && <ErrorState error={error} />}
      <Button onClick={() => void previewChange()} disabled={pending}>
        {pending ? "Validating…" : "Compute policy impact preview"}
      </Button>
      {preview && (
        <div className="stack">
          <h3>Concrete migration impact</h3>
          <small className="mono">
            {preview.previewDigest} · expires {when(preview.expiresAt)}
          </small>
          <Notice tone="gold">
            {preview.affectedReservationIds.length} reserved work items are
            affected. {preview.supersededOfferIds.length} outstanding offers
            will be superseded and need fresh learner consent. Pool definitions
            and existing grants are unchanged.
          </Notice>
          {preview.impacts.map((impact) => (
            <details key={impact.scopeId}>
              <summary>
                {policy.scopes.find((s) => s.scopeId === impact.scopeId)
                  ?.label ?? impact.scopeId}
              </summary>
              <p>
                Effective deadline:{" "}
                {impact.before.effectiveDeadline
                  ? when(impact.before.effectiveDeadline)
                  : "None"}{" "}
                →{" "}
                {impact.after.effectiveDeadline
                  ? when(impact.after.effectiveDeadline)
                  : "None"}
              </p>
              <h3>Current work envelope</h3>
              <ScopeQuotas
                quotas={impact.before.quotas}
                scopes={policy.scopes}
              />
              <h3>Proposed work envelope</h3>
              <ScopeQuotas
                quotas={impact.after.quotas}
                scopes={policy.scopes}
              />
            </details>
          ))}
          <Field label="Reason for migration" htmlFor="migration-reason">
            <textarea
              id="migration-reason"
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
            I reviewed this exact migration, its affected work and superseded
            offers.
          </label>
          <Button
            kind="primary"
            disabled={!reviewed || !reason.trim() || pending}
            onClick={() => void apply()}
          >
            Apply reviewed migration
          </Button>
        </div>
      )}
    </Dialog>
  );
}
