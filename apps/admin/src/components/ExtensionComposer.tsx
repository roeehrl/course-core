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
import { useT } from "../i18n";

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
  const t = useT();
  // Days move a deadline; planned minutes and episodes raise a work cap. Blank means none.
  const hasDeadline = Boolean(scope.window || scope.hardDeadline);
  const [days, setDays] = useState(hasDeadline ? "2" : "");
  const [minutes, setMinutes] = useState("");
  const [episodes, setEpisodes] = useState("");
  const amount = (value: string) =>
    value.trim() && Number(value) > 0 ? Number(value) : undefined;
  const amounts = {
    ...(amount(days) ? { days: amount(days)! } : {}),
    ...(amount(minutes) ? { minutes: amount(minutes)! } : {}),
    ...(amount(episodes) ? { episodes: amount(episodes)! } : {}),
  };
  const units = new Set(
    policy.pools
      .filter((pool) => scope.extensions?.poolIds.includes(pool.poolId))
      .map((pool) => pool.unit),
  );
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
        { scopeId: scope.scopeId, ...amounts },
        abort.signal,
      );
      if (
        value.enrollmentId !== policy.enrollmentId ||
        value.scopeId !== scope.scopeId ||
        (value.days ?? undefined) !== amounts.days
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
      ...amounts,
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
  const canDays =
    hasDeadline &&
    (units.has("calendar_day") || units.has("scope_calendar_day"));
  const canMinutes = units.has("planned_minute");
  const canEpisodes = units.has("episode");
  const enabled =
    scope.extensions?.enabled &&
    (canDays || canMinutes || canEpisodes) &&
    policy.status === "active";
  const scopedActivities = policy.activities.filter((activity) =>
    policy.constraints
      .find((c) => c.scopeId === activity.scopeId)
      ?.ancestorScopeIds.includes(scope.scopeId),
  );
  return (
    <Card
      title={t("extensionComposer.title")}
      eyebrow={t("extensionComposer.eyebrow")}
    >
      <Notice tone="blue">{t("extensionComposer.notice")}</Notice>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void makePreview();
        }}
      >
        {(canDays || !enabled) && (
          <Field
            label={t("extensionComposer.days")}
            htmlFor="extension-days"
            hint={t("extensionComposer.days.hint")}
          >
            <input
              id="extension-days"
              type="number"
              min={1}
              max={366}
              step={1}
              value={days}
              onChange={(e) => {
                invalidate();
                setDays(e.target.value);
              }}
              disabled={pending}
            />
          </Field>
        )}
        {canMinutes && (
          <Field
            label={t("extensionComposer.minutes")}
            htmlFor="extension-minutes"
            hint={t("extensionComposer.minutes.hint")}
          >
            <input
              id="extension-minutes"
              type="number"
              min={1}
              max={100000}
              step={1}
              value={minutes}
              onChange={(e) => {
                invalidate();
                setMinutes(e.target.value);
              }}
              disabled={pending}
            />
          </Field>
        )}
        {canEpisodes && (
          <Field
            label={t("extensionComposer.episodes")}
            htmlFor="extension-episodes"
            hint={t("extensionComposer.episodes.hint")}
          >
            <input
              id="extension-episodes"
              type="number"
              min={1}
              max={1000}
              step={1}
              value={episodes}
              onChange={(e) => {
                invalidate();
                setEpisodes(e.target.value);
              }}
              disabled={pending}
            />
          </Field>
        )}
        <Button
          type="submit"
          kind="primary"
          disabled={
            !enabled || previewing || pending || !Object.keys(amounts).length
          }
        >
          {previewing
            ? t("extensionComposer.resolving")
            : t("extensionComposer.preview")}
        </Button>
        {!enabled && <small>{t("extensionComposer.notExtendable")}</small>}
      </form>
      {Boolean(error) && <ErrorState error={error} onRetry={onRefresh} />}
      {preview && (
        <div className="preview-result">
          <h3>{t("extensionComposer.resolved")}</h3>
          <small>
            {t("extensionComposer.revisions", {
              revision: preview.revision,
              policy: preview.policyRevision,
              ledger: preview.ledgerRevision,
            })}
          </small>
          <ExtensionTerms
            terms={preview}
            scopes={policy.scopes}
            pools={policy.pools}
          />
          <Notice tone="gold">{t("extensionComposer.hypothetical")}</Notice>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void propose();
            }}
          >
            <fieldset disabled={!canPropose || pending} className="stack">
              <legend>{t("extensionComposer.legend.proposal")}</legend>
              <fieldset className="stack">
                <legend>{t("extensionComposer.legend.rationale")}</legend>
                {policy.rationaleEvents.map((event) => (
                  <label className="check-label" key={event.id}>
                    <input
                      type="checkbox"
                      checked={rationale.includes(event.id)}
                      onChange={() => setRationale(toggle(rationale, event.id))}
                    />
                    <span dir="auto">{event.label}</span>
                  </label>
                ))}
              </fieldset>
              <fieldset className="stack">
                <legend>{t("extensionComposer.legend.activities")}</legend>
                {scopedActivities.map((activity) => (
                  <label className="check-label" key={activity.id}>
                    <input
                      type="checkbox"
                      checked={activities.includes(activity.id)}
                      onChange={() =>
                        setActivities(toggle(activities, activity.id))
                      }
                    />
                    <span dir="auto">{activity.label}</span>
                  </label>
                ))}
              </fieldset>
              <Field
                label={t("extensionComposer.impact")}
                htmlFor="plan-impact"
              >
                <textarea
                  id="plan-impact"
                  required
                  maxLength={2000}
                  value={impact}
                  onChange={(e) => {
                    setImpact(e.target.value);
                    setReviewed(false);
                  }}
                  placeholder={t("extensionComposer.impact.placeholder")}
                />
              </Field>
              <Field
                label={t("extensionComposer.alternatives")}
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
                  placeholder={t("extensionComposer.alternatives.placeholder")}
                />
              </Field>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                />
                {t("extensionComposer.reviewed")}
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
                {pending
                  ? t("extensionComposer.proposing")
                  : t("extensionComposer.propose")}
              </Button>
            </fieldset>
            {!canPropose && (
              <small>{t("extensionComposer.cannotPropose")}</small>
            )}
          </form>
        </div>
      )}
    </Card>
  );
}
