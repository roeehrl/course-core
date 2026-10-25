import { useState } from "react";
import { Hourglass } from "lucide-react";
import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import type { AllowanceOffer, Allowances } from "../domain/policyLevels";
import { useRemote } from "../hooks/useAdmin";
import { useSingleFlight } from "../components/LedgerActionDialog";
import { BatchAdjustDialog } from "../components/BatchAdjustDialog";
import { useScopeLabel } from "../components/scopeLabel";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  Notice,
} from "../components/ui";
import { useFormatters, useI18n, useT, type MessageKey } from "../i18n";

type Change = AllowanceOffer["change"];

/** Extensions and accommodations across every learner of this course: the offers learners
 * accepted that wait for an administrator, everything granted or adjusted so far, how much of
 * each allowance is used, and group adjustments (accommodations or outages) for many learners. */
export function AllowancesView({
  data,
  client,
}: {
  data: CourseWorkspace;
  client: AdminClient;
}) {
  const t = useT();
  const [view, setView] = useState<"pending" | "all">("pending");
  const [batching, setBatching] = useState(false);
  const [message, setMessage] = useState("");
  const canWrite = data.permissions.includes("policy.write");
  const remote = useRemote(
    (signal) => client.getAllowances!(data.course.id, view, signal),
    [client, data.course.id, view],
  );
  // The course's levels (chapters, episodes) come from one learner's policy: they are shared.
  const sample = data.enrollments.find((e) => e.status === "active");
  const scopes = useRemote(
    async (signal) =>
      sample ? (await client.getPolicy(sample.id, signal)).scopes : [],
    [client, sample?.id],
  );
  const batches = useRemote(
    (signal) =>
      client.getAccommodationBatches
        ? client.getAccommodationBatches(data.course.id, signal)
        : Promise.resolve(undefined),
    [client, data.course.id, message],
  );
  return (
    <div className="page-stack">
      <div className="section-heading">
        <div>
          <h2>{t("allowancesView.heading")}</h2>
          <p>{t("allowancesView.intro")}</p>
        </div>
        <span className="large-icon">
          <Hourglass size={28} aria-hidden="true" />
        </span>
      </div>
      {message && <Notice tone="green">{message}</Notice>}
      <div
        className="tag-row"
        role="group"
        aria-label={t("allowancesView.show")}
      >
        <Button
          type="button"
          kind={view === "pending" ? "primary" : "secondary"}
          aria-pressed={view === "pending"}
          onClick={() => setView("pending")}
        >
          {t("allowancesView.tab.pending")}
        </Button>
        <Button
          type="button"
          kind={view === "all" ? "primary" : "secondary"}
          aria-pressed={view === "all"}
          onClick={() => setView("all")}
        >
          {t("allowancesView.tab.all")}
        </Button>
        {canWrite &&
          client.previewAccommodationBatch &&
          client.applyAccommodationBatch && (
            <Button
              type="button"
              disabled={!scopes.data?.length}
              onClick={() => setBatching(true)}
            >
              {t("allowancesView.batch")}
            </Button>
          )}
      </div>
      {batching && scopes.data && (
        <BatchAdjustDialog
          client={client}
          courseId={data.course.id}
          enrollments={data.enrollments}
          scopes={scopes.data}
          onClose={() => setBatching(false)}
          onApplied={(result) => {
            setMessage(
              t("allowancesView.batchApplied", { count: result.applied }),
            );
            remote.reload();
          }}
        />
      )}
      {remote.loading ? (
        <Loading label={t("allowancesView.loading")} />
      ) : remote.error ? (
        <ErrorState error={remote.error} onRetry={remote.reload} />
      ) : (
        remote.data && (
          <AllowanceLists
            data={remote.data}
            scopes={scopes.data ?? []}
            client={client}
            canWrite={canWrite}
            onChanged={(text) => {
              setMessage(text);
              remote.reload();
            }}
          />
        )
      )}
      {batches.data && batches.data.batches.length > 0 && (
        <Card
          title={t("allowancesView.batches.title")}
          eyebrow={t("allowancesView.batches.eyebrow")}
        >
          <BatchList
            batches={batches.data.batches}
            scopes={scopes.data ?? []}
          />
        </Card>
      )}
    </div>
  );
}

function useChangeText() {
  const t = useT();
  return (change: Change) => {
    const parts = [
      change.deadline &&
        t("allowancesView.change.days", {
          count: change.deadline.calendarDays,
        }),
      change.work?.additionalMinutes &&
        t("allowancesView.change.minutes", {
          count: change.work.additionalMinutes,
        }),
      change.work?.additionalEpisodes &&
        t("allowancesView.change.episodes", {
          count: change.work.additionalEpisodes,
        }),
    ].filter(Boolean);
    return parts.length ? parts.join(", ") : t("allowancesView.change.none");
  };
}

function AllowanceLists({
  data,
  scopes,
  client,
  canWrite,
  onChanged,
}: {
  data: Allowances;
  scopes: import("../domain/policy").ScopePolicy[];
  client: AdminClient;
  canWrite: boolean;
  onChanged: (message: string) => void;
}) {
  const i18n = useI18n();
  const t = i18n.t;
  const { when } = useFormatters();
  const scopeNames = useScopeLabel();
  const changeText = useChangeText();
  const learner = (name: string | null) => name ?? t("allowancesView.unnamed");
  const waiting = data.offers.filter(
    (o) => o.state === "accepted_pending_admin",
  );
  return (
    <>
      <Card
        title={t("allowancesView.pending.title")}
        eyebrow={t("allowancesView.pending.eyebrow")}
      >
        {!waiting.length ? (
          <EmptyState title={t("allowancesView.pending.empty.title")}>
            {t("allowancesView.pending.empty.body")}
          </EmptyState>
        ) : (
          <ul className="stack">
            {waiting.map((offer) => (
              <PendingOffer
                key={`${offer.enrollmentId}:${offer.offerId}`}
                offer={offer}
                scopeName={scopeNames.byId(scopes, offer.scopeId)}
                client={client}
                canWrite={canWrite && Boolean(client.approveExtension)}
                onChanged={onChanged}
              />
            ))}
          </ul>
        )}
      </Card>
      {data.view === "all" && (
        <>
          <Card
            title={t("allowancesView.offers.title")}
            eyebrow={t("allowancesView.offers.eyebrow")}
          >
            {!data.offers.length ? (
              <small>{t("allowancesView.offers.empty")}</small>
            ) : (
              <div
                className="table-wrap"
                tabIndex={0}
                role="region"
                aria-label={t("allowancesView.offers.title")}
              >
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{t("allowancesView.col.learner")}</th>
                      <th scope="col">{t("allowancesView.col.where")}</th>
                      <th scope="col">{t("allowancesView.col.what")}</th>
                      <th scope="col">{t("allowancesView.col.state")}</th>
                      <th scope="col">{t("allowancesView.col.when")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.offers.map((offer) => (
                      <tr key={`${offer.enrollmentId}:${offer.offerId}`}>
                        <td>
                          <bdi>{learner(offer.displayName)}</bdi>
                        </td>
                        <td>
                          <bdi>{scopeNames.byId(scopes, offer.scopeId)}</bdi>
                        </td>
                        <td>{changeText(offer.change)}</td>
                        <td>
                          <Badge
                            tone={offer.state === "granted" ? "green" : "gold"}
                          >
                            {t(
                              `allowancesView.state.${offer.state}` as MessageKey,
                            )}
                          </Badge>
                        </td>
                        <td>{when(offer.lastTransitionAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <Card
            title={t("allowancesView.accommodations.title")}
            eyebrow={t("allowancesView.accommodations.eyebrow")}
          >
            {!data.accommodations.length ? (
              <small>{t("allowancesView.accommodations.empty")}</small>
            ) : (
              <ul className="stack">
                {data.accommodations.map((row) => (
                  <li key={`${row.enrollmentId}:${row.accommodationId}`}>
                    <Badge tone="blue">
                      {t(`allowancesView.kind.${row.kind}` as MessageKey)}
                    </Badge>{" "}
                    {t("allowancesView.accommodations.row", {
                      learner: learner(row.displayName),
                      scope: scopeNames.byId(scopes, row.scopeId),
                      date: when(row.authorizedAt),
                    })}
                    {row.batchId && (
                      <small> {t("allowancesView.accommodations.batch")}</small>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card
            title={t("allowancesView.pools.title")}
            eyebrow={t("allowancesView.pools.eyebrow")}
          >
            {!data.pools.length ? (
              <small>{t("allowancesView.pools.empty")}</small>
            ) : (
              <ul className="stack">
                {data.pools.map((pool) => (
                  <li key={pool.poolId}>
                    <span className="mono" dir="ltr">
                      {pool.poolId}
                    </span>{" "}
                    {t("allowancesView.pools.row", {
                      used: pool.used,
                      total: pool.total,
                      unit: pool.unit,
                      learners: pool.learners,
                      grants: pool.grants,
                    })}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </>
  );
}

function PendingOffer({
  offer,
  scopeName,
  client,
  canWrite,
  onChanged,
}: {
  offer: AllowanceOffer;
  scopeName: string;
  client: AdminClient;
  canWrite: boolean;
  onChanged: (message: string) => void;
}) {
  const i18n = useI18n();
  const t = i18n.t;
  const { when } = useFormatters();
  const changeText = useChangeText();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const flight = useSingleFlight();
  const name = offer.displayName ?? t("allowancesView.unnamed");
  const context = (action: string) => ({
    expectedRevision: offer.enrollmentRevision,
    idempotencyKey: flight.key({ action, offer: offer.offerId }),
  });
  return (
    <li className="record stack">
      <div className="split-line">
        <strong>
          <bdi>{name}</bdi>
        </strong>
        <Badge tone="gold">
          {t("allowancesView.state.accepted_pending_admin")}
        </Badge>
      </div>
      <p>
        {t("allowancesView.pending.row", {
          what: changeText(offer.change),
          scope: scopeName,
          accepted: offer.acceptedAt
            ? when(offer.acceptedAt)
            : t("allowancesView.notYet"),
          expires: when(offer.expiresAt),
        })}
      </p>
      <small>
        {t("allowancesView.pending.pools", {
          pools: offer.poolDebits
            .map((d) => `${d.poolId} × ${i18n.number(d.amount)}`)
            .join(", "),
        })}
      </small>
      {Boolean(flight.error) && <ErrorState error={flight.error} />}
      {canWrite && (
        <div className="stack">
          <div className="tag-row">
            <Button
              type="button"
              kind="primary"
              disabled={flight.pending}
              onClick={() =>
                void flight.run(async () => {
                  await client.approveExtension!(
                    offer.enrollmentId,
                    offer.offerId,
                    context("approve"),
                  );
                  onChanged(t("allowancesView.approved", { name }));
                })
              }
            >
              {t("allowancesView.approve")}
            </Button>
            <Button
              type="button"
              disabled={flight.pending}
              onClick={() => setRejecting((v) => !v)}
            >
              {t("allowancesView.reject")}
            </Button>
          </div>
          {rejecting && client.rejectExtension && (
            <div className="stack">
              <Field
                label={t("allowancesView.reject.reason")}
                htmlFor={`reject-${offer.offerId}`}
                hint={t("allowancesView.reject.hint")}
              >
                <input
                  id={`reject-${offer.offerId}`}
                  maxLength={1000}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </Field>
              <div>
                <Button
                  type="button"
                  kind="danger"
                  disabled={flight.pending || !reason.trim()}
                  onClick={() =>
                    void flight.run(async () => {
                      await client.rejectExtension!(
                        offer.enrollmentId,
                        offer.offerId,
                        reason.trim(),
                        context("reject"),
                      );
                      onChanged(t("allowancesView.rejected", { name }));
                    })
                  }
                >
                  {t("allowancesView.reject.confirm")}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function BatchList({
  batches,
  scopes,
}: {
  batches: NonNullable<import("../domain/policyLevels").Batches>["batches"];
  scopes: import("../domain/policy").ScopePolicy[];
}) {
  const t = useT();
  const { when } = useFormatters();
  const scopeNames = useScopeLabel();
  const changeText = useChangeText();
  return (
    <ul className="stack">
      {batches.map((batch) => (
        <li key={batch.batchId}>
          <Badge tone="blue">
            {t(`allowancesView.kind.${batch.kind}` as MessageKey)}
          </Badge>{" "}
          {t("allowancesView.batches.row", {
            what: changeText(batch.change),
            scope: scopeNames.byId(scopes, batch.scopeId),
            count: batch.applied,
            by: batch.appliedBy,
            date: when(batch.appliedAt),
          })}
          {batch.reason && (
            <small>
              {" "}
              <bdi>{batch.reason}</bdi>
            </small>
          )}
        </li>
      ))}
    </ul>
  );
}
