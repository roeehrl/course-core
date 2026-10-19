import { useEffect, useRef, useState } from "react";
import type { AdminClient } from "../domain/contracts";
import type {
  ExtensionPreview,
  ExtensionProposal,
  ExtensionProposalResult,
  LearningPolicy,
  ScopePolicy,
} from "../domain/policy";
import { Button, Card, ErrorState, Field, Notice } from "./ui";
import { ExtensionTerms } from "./ExtensionTerms";
import { AdminError } from "../domain/errors";
import { randomId } from "../domain/webCrypto";

export function ExtensionComposer({
  policy,
  scope,
  client,
  canPropose,
  onUpdated,
  onRefresh,
}: {
  policy: LearningPolicy;
  scope: ScopePolicy;
  client: AdminClient;
  canPropose: boolean;
  onUpdated: (result: ExtensionProposalResult) => void;
  onRefresh: () => void;
}) {
  const [days, setDays] = useState(2);
  const [preview, setPreview] = useState<ExtensionPreview>();
  const [error, setError] = useState<unknown>();
  const [previewing, setPreviewing] = useState(false);
  const [pending, setPending] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [rationale, setRationale] = useState<string[]>([]);
  const [activities, setActivities] = useState<string[]>([]);
  const [impact, setImpact] = useState("");
  const [alternatives, setAlternatives] = useState("");
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const alive = useRef(true);
  const retries = useRef(new Map<string, string>());
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
      controller.current?.abort();
    };
  }, []);
  function invalidate() {
    generation.current++;
    controller.current?.abort();
    setPreview(undefined);
    setReviewed(false);
    setError(undefined);
    setPreviewing(false);
  }
  async function makePreview() {
    invalidate();
    const token = generation.current;
    const abort = new AbortController();
    controller.current = abort;
    setPreviewing(true);
    try {
      const value = await client.previewExtension(
        policy.enrollmentId,
        { scopeId: scope.scopeId, days },
        abort.signal,
      );
      if (
        value.enrollmentId !== policy.enrollmentId ||
        value.scopeId !== scope.scopeId ||
        value.days !== days
      )
        throw new AdminError("invalid_response");
      if (
        value.revision !== policy.revision ||
        value.policyRevision !== policy.policyRevision ||
        value.ledgerRevision !== policy.ledgerRevision
      )
        throw new AdminError("stale_revision");
      if (
        alive.current &&
        !abort.signal.aborted &&
        token === generation.current
      )
        setPreview(value);
    } catch (cause) {
      if (
        alive.current &&
        !abort.signal.aborted &&
        token === generation.current
      )
        setError(cause);
    } finally {
      if (alive.current && token === generation.current) setPreviewing(false);
    }
  }
  async function propose() {
    if (!reviewed || !preview || busy.current || !canPropose) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    const input: ExtensionProposal = {
      scopeId: scope.scopeId,
      days,
      rationaleEventIds: rationale,
      episodeIds: activities,
      planImpact: impact.trim(),
      alternatives: alternatives
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean),
    };
    const fingerprint = JSON.stringify(input);
    let key = retries.current.get(fingerprint);
    if (!key) {
      key = randomId();
      retries.current.set(fingerprint, key);
    }
    try {
      const result = await client.proposeExtension(policy.enrollmentId, input, {
        expectedRevision: preview.revision,
        idempotencyKey: key,
      });
      if (alive.current) onUpdated(result);
    } catch (cause) {
      if (alive.current) setError(cause);
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
    }
  }
  function toggle(values: string[], value: string) {
    setReviewed(false);
    return values.includes(value)
      ? values.filter((item) => item !== value)
      : [...values, value];
  }
  const enabled =
    scope.extensions?.enabled &&
    !!(scope.window || scope.hardDeadline) &&
    policy.status === "active";
  const scopedActivities = policy.activities.filter((activity) =>
    policy.constraints
      .find((c) => c.scopeId === activity.scopeId)
      ?.ancestorScopeIds.includes(scope.scopeId),
  );
  return (
    <Card
      title="Preview a calendar extension"
      eyebrow="No debit, grant or consent on preview"
    >
      <Notice tone="blue">
        The request adds calendar days to this scope's deadline or anchored
        window. Current work caps stay unchanged. The server rechecks ancestor
        caps, allowance and revisions.
      </Notice>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void makePreview();
        }}
      >
        <Field
          label="Additional calendar days"
          htmlFor="extension-days"
          hint="The API accepts 1–366 days; this scope’s per-grant allowance and ancestor caps may be stricter."
        >
          <input
            id="extension-days"
            type="number"
            required
            min={1}
            max={366}
            step={1}
            value={days}
            onChange={(e) => {
              invalidate();
              setDays(Number(e.target.value));
            }}
            disabled={pending}
          />
        </Field>
        <Button
          type="submit"
          kind="primary"
          disabled={!enabled || previewing || pending}
        >
          {previewing ? "Resolving exact terms…" : "Preview calendar extension"}
        </Button>
        {!enabled && (
          <small>
            This scope is not currently extendable: it needs an active
            enrollment, an enabled allowance and a local deadline or window.
          </small>
        )}
      </form>
      {Boolean(error) && <ErrorState error={error} onRetry={onRefresh} />}
      {preview && (
        <div className="preview-result">
          <h3>Resolved extension terms</h3>
          <small className="mono">
            Enrollment revision {preview.revision} · Policy{" "}
            {preview.policyRevision} · Ledger {preview.ledgerRevision}
          </small>
          <ExtensionTerms
            terms={preview}
            scopes={policy.scopes}
            pools={policy.pools}
          />
          <Notice tone="gold">
            No allowance has been consumed. These balances are hypothetical
            after a future grant. Proposing requests the learner's consent; it
            cannot supply that consent.
          </Notice>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void propose();
            }}
          >
            <fieldset disabled={!canPropose || pending} className="stack">
              <legend>Proposal rationale and activities</legend>
              <fieldset className="stack">
                <legend>Scoped rationale events</legend>
                {policy.rationaleEvents.map((event) => (
                  <label className="check-label" key={event.id}>
                    <input
                      type="checkbox"
                      checked={rationale.includes(event.id)}
                      onChange={() => setRationale(toggle(rationale, event.id))}
                    />
                    {event.label}
                  </label>
                ))}
              </fieldset>
              <fieldset className="stack">
                <legend>Proposed activities in this scope</legend>
                {scopedActivities.map((activity) => (
                  <label className="check-label" key={activity.id}>
                    <input
                      type="checkbox"
                      checked={activities.includes(activity.id)}
                      onChange={() =>
                        setActivities(toggle(activities, activity.id))
                      }
                    />
                    {activity.label}
                  </label>
                ))}
              </fieldset>
              <Field label="Plan impact" htmlFor="plan-impact">
                <textarea
                  id="plan-impact"
                  required
                  maxLength={2000}
                  value={impact}
                  onChange={(e) => {
                    setImpact(e.target.value);
                    setReviewed(false);
                  }}
                  placeholder="Explain how the additional days affect the learner’s existing plan."
                />
              </Field>
              <Field
                label="Alternatives (one per line)"
                htmlFor="proposal-alternatives"
              >
                <textarea
                  id="proposal-alternatives"
                  required
                  maxLength={4000}
                  value={alternatives}
                  onChange={(e) => {
                    setAlternatives(e.target.value);
                    setReviewed(false);
                  }}
                  placeholder="For example, continue with the current deadline."
                />
              </Field>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                />
                I reviewed these exact terms and want to propose them to the
                learner. This is not learner consent.
              </label>
              <Button
                kind="primary"
                type="submit"
                disabled={
                  !reviewed ||
                  !rationale.length ||
                  !activities.length ||
                  !impact.trim() ||
                  !alternatives.trim() ||
                  pending
                }
              >
                {pending ? "Proposing…" : "Propose offer to learner"}
              </Button>
            </fieldset>
            {!canPropose && (
              <small>
                Your role can inspect policy and preview terms but cannot
                propose offers.
              </small>
            )}
          </form>
        </div>
      )}
    </Card>
  );
}
