import { useId, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import {
  overviewErrorMessage,
  type AuditPage,
  type AuditQuery,
} from "../domain/overview";
import { useRemote } from "../hooks/useAdmin";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Notice,
  TechnicalDetails,
  SkeletonRows,
} from "../components/ui";
import {
  useFormatters,
  useI18n,
  useT,
  type AdminTranslator,
  type MessageKey,
} from "../i18n";
import auditMessages from "../i18n/messages/en/auditView.json";
import "./workspacePages.css";
import { AuditExport } from "../components/AuditExport";
import { PolicyHistory } from "../components/PolicyHistory";

/** Workspace audit log. Staff and system actions show what changed; learner and agent
 * events show only that they happened (learner privacy). */
export function AuditView({
  data,
  client,
}: {
  data: CourseWorkspace;
  client: AdminClient;
}) {
  const t = useT();
  if (!client.audit || !data.course.workspaceId)
    return (
      <Card title={t("auditView.title")}>
        <EmptyState title={t("auditView.unavailable.title")}>
          {t("auditView.unavailable.body")}
        </EmptyState>
      </Card>
    );
  if (!data.permissions.includes("audit.read"))
    return <Notice tone="gold">{t("auditView.forbidden")}</Notice>;
  return (
    <div className="page-stack">
      <AuditLog port={client.audit} workspaceId={data.course.workspaceId} />
      {client.platform && data.permissions.includes("policy.read") && (
        <PolicyHistory port={client.platform} courseId={data.course.id} />
      )}
      {client.platform && data.permissions.includes("audit.export") && (
        <AuditExport
          port={client.platform}
          workspaceId={data.course.workspaceId}
        />
      )}
    </div>
  );
}

/** Every kind of event the log can name in a sentence (auditView.event.<type>). */
const EVENT_TYPES = Object.keys(auditMessages)
  .filter(
    (key) => key.startsWith("event.") && !/^event\.(other|unknown)$/.test(key),
  )
  .map((key) => key.slice("event.".length));

/** The "What happened" choices: each kind of event by its sentence, grouped by area (areas
 * with the same name share a group), groups and choices in the reader's alphabetical order. A
 * sentence two kinds share is offered once. */
function eventChoices(i18n: AdminTranslator) {
  const groups = new Map<string, { type: string; label: string }[]>();
  const seen = new Set<string>();
  for (const type of EVENT_TYPES) {
    const label = i18n.t(`auditView.event.${type}` as MessageKey);
    if (seen.has(label)) continue;
    seen.add(label);
    const areaKey = `auditView.area.${type.split(".")[0]}` as MessageKey;
    const area = i18n.has(areaKey) ? i18n.t(areaKey) : "";
    groups.set(area, [...(groups.get(area) ?? []), { type, label }]);
  }
  const collator = new Intl.Collator(i18n.locale);
  return [...groups]
    .sort(([a], [b]) => collator.compare(a, b))
    .map(([area, types]) => ({
      area,
      types: types.sort((a, b) => collator.compare(a.label, b.label)),
    }));
}

function AuditLog({
  port,
  workspaceId,
}: {
  port: NonNullable<AdminClient["audit"]>;
  workspaceId: string;
}) {
  const id = useId();
  const t = useT();
  const i18n = useI18n();
  const [actorKind, setActorKind] = useState<AuditQuery["actorKind"] | "">("");
  const [type, setType] = useState("");
  const [pages, setPages] = useState<string[]>([]);
  const before = pages.at(-1);
  const page = useRemote(
    (signal) =>
      port.list(
        workspaceId,
        {
          ...(before ? { before } : {}),
          ...(actorKind ? { actorKind } : {}),
          ...(type ? { type } : {}),
          limit: 50,
        },
        signal,
      ),
    [port, workspaceId, actorKind, type, before],
  );
  return (
    <div className="page-stack">
      <Notice tone="blue" title={t("auditView.privacy.title")}>
        {t("auditView.privacy.body")}
      </Notice>
      <Card title={t("auditView.activity")}>
        <div className="tag-row audit-controls">
          <Field label={t("auditView.filter.label")} htmlFor={`${id}-kind`}>
            <select
              id={`${id}-kind`}
              value={actorKind}
              onChange={(e) => {
                setActorKind(e.target.value as AuditQuery["actorKind"] | "");
                setPages([]);
              }}
            >
              <option value="">{t("auditView.filter.everyone")}</option>
              <option value="staff">{t("auditView.filter.staff")}</option>
              <option value="system">{t("auditView.filter.system")}</option>
              <option value="learner">{t("auditView.filter.learner")}</option>
              <option value="agent">{t("auditView.filter.agent")}</option>
            </select>
          </Field>
          <Field
            label={t("auditView.filter.type.label")}
            htmlFor={`${id}-type`}
          >
            <select
              id={`${id}-type`}
              value={type}
              onChange={(e) => {
                setType(e.target.value);
                setPages([]);
              }}
            >
              <option value="">{t("auditView.filter.type.all")}</option>
              {eventChoices(i18n).map(({ area, types }) => (
                <optgroup key={area} label={area}>
                  {types.map((choice) => (
                    <option key={choice.type} value={choice.type}>
                      {choice.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>
        </div>
        {page.loading ? (
          <SkeletonRows label={t("auditView.loading")} rows={8} />
        ) : page.error || !page.data ? (
          <Notice tone="red">{overviewErrorMessage(page.error, t)}</Notice>
        ) : page.data.events.length === 0 ? (
          <EmptyState title={t("auditView.empty.title")}>
            {t("auditView.empty.body")}
          </EmptyState>
        ) : (
          <AuditTable page={page.data} />
        )}
        {(pages.length > 0 || page.data?.nextBefore) && (
          <nav className="audit-pager" aria-label={t("auditView.table.label")}>
            <span className="audit-page" aria-live="polite">
              {t("auditView.page", { page: pages.length + 1 })}
            </span>
            <div className="button-row">
              {pages.length > 1 && (
                <Button kind="quiet" onClick={() => setPages([])}>
                  {t("auditView.newest")}
                </Button>
              )}
              <Button
                disabled={pages.length === 0}
                onClick={() => setPages(pages.slice(0, -1))}
              >
                <ChevronLeft
                  size={16}
                  aria-hidden="true"
                  className="flip-rtl"
                />
                {t("auditView.newer")}
              </Button>
              <Button
                disabled={!page.data?.nextBefore}
                onClick={() => setPages([...pages, page.data!.nextBefore!])}
              >
                {t("auditView.older")}
                <ChevronRight
                  size={16}
                  aria-hidden="true"
                  className="flip-rtl"
                />
              </Button>
            </div>
          </nav>
        )}
      </Card>
    </div>
  );
}

type AuditEvent = AuditPage["events"][number];
const MICRO = 1_000_000;

/** A short fact pulled from a recorded payload: an amount, a version, a staff reason. */
function payloadFacts(
  payload: AuditEvent["payload"],
  i18n: AdminTranslator,
): string[] {
  if (!payload) return [];
  const t = i18n.t;
  const money = (micro: unknown) =>
    typeof micro === "number" && Number.isFinite(micro)
      ? i18n.currency(micro / MICRO, "USD")
      : null;
  const facts: string[] = [];
  const charged = money(payload.chargedMicroUsd);
  if (charged) facts.push(t("auditView.fact.cost", { amount: charged }));
  else {
    const estimate = money(payload.estimatedMicroUsd);
    if (estimate)
      facts.push(t("auditView.fact.estimate", { amount: estimate }));
  }
  const billed = money(payload.billedMicroUsd);
  if (billed) facts.push(t("auditView.fact.billed", { amount: billed }));
  const version = [payload.version, payload.toVersion, payload.to].find(
    (value): value is string =>
      typeof value === "string" && /^\d+\.\d+\.\d+/.test(value),
  );
  if (version) facts.push(t("auditView.fact.version", { version }));
  const outcome = [payload.state, payload.outcome, payload.result].find(
    (value): value is string =>
      typeof value === "string" && i18n.has(`ui.status.${value}` as MessageKey),
  );
  if (outcome)
    facts.push(
      t("auditView.fact.outcome", {
        outcome: t(`ui.status.${outcome}` as MessageKey),
      }),
    );
  // A staff member's reason, in their words; a reason code stays in the technical details.
  if (
    typeof payload.reason === "string" &&
    payload.reason.trim() &&
    !/^[A-Z0-9_]+$/.test(payload.reason)
  )
    facts.push(
      t("auditView.fact.reason", {
        reason:
          payload.reason.length > 160
            ? `${payload.reason.slice(0, 159)}…`
            : payload.reason,
      }),
    );
  return facts;
}

/** What happened, in words: the event's own sentence, or the area it belongs to. */
function eventSentence(type: string, i18n: AdminTranslator) {
  const own = `auditView.event.${type}` as MessageKey;
  if (i18n.has(own)) return i18n.t(own);
  const area = type.split(".")[0] ?? "";
  const areaKey = `auditView.area.${area}` as MessageKey;
  return i18n.has(areaKey)
    ? i18n.t("auditView.event.other", { area: i18n.t(areaKey) })
    : i18n.t("auditView.event.unknown");
}

function AuditTable({ page }: { page: AuditPage }) {
  const t = useT();
  const i18n = useI18n();
  const { when } = useFormatters();
  return (
    <div
      className="table-wrap"
      tabIndex={0}
      role="region"
      aria-label={t("auditView.table.label")}
    >
      <table className="stacked-table audit-table">
        <caption className="sr-only">{t("auditView.table.caption")}</caption>
        <colgroup>
          <col />
          <col className="audit-col-who" />
          <col className="audit-col-when" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">{t("auditView.table.what")}</th>
            <th scope="col">{t("auditView.table.who")}</th>
            <th scope="col">{t("auditView.table.when")}</th>
          </tr>
        </thead>
        <tbody>
          {page.events.map((e) => {
            const facts = e.payloadWithheld
              ? []
              : payloadFacts(e.payload, i18n);
            return (
              <tr key={e.id}>
                <th scope="row" className="audit-what">
                  <span className="audit-sentence">
                    {eventSentence(e.type, i18n)}
                  </span>
                  {facts.length > 0 && (
                    <span className="audit-facts">
                      {facts.map((fact) => (
                        <span key={fact}>{fact}</span>
                      ))}
                    </span>
                  )}
                  {e.payloadWithheld && (
                    <span className="audit-withheld muted">
                      {e.enrollmentId
                        ? t("auditView.withheldLearner")
                        : t("auditView.withheld")}
                    </span>
                  )}
                  <AuditRecord event={e} />
                </th>
                <td data-label={t("auditView.table.who")}>
                  <span className="audit-who">
                    <Badge tone={e.actorKind === "staff" ? "blue" : "neutral"}>
                      <span className="status-text">
                        {i18n.has(`auditView.actorKind.${e.actorKind}`)
                          ? t(`auditView.actorKind.${e.actorKind}`)
                          : e.actorKind}
                      </span>
                    </Badge>
                    {e.actor && <bdi>{e.actor}</bdi>}
                  </span>
                </td>
                <td
                  className="cell-date"
                  data-label={t("auditView.table.when")}
                >
                  {when(e.at)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The record as stored, for support: the event's code, its ids and every payload field. */
function AuditRecord({ event }: { event: AuditEvent }) {
  const t = useT();
  return (
    <TechnicalDetails>
      <dl className="audit-fields">
        <div>
          <dt>{t("auditView.technical.type")}</dt>
          <dd className="mono" dir="ltr">
            {event.type}
          </dd>
        </div>
        <div>
          <dt>{t("auditView.technical.id")}</dt>
          <dd className="mono" dir="ltr">
            {event.id}
          </dd>
        </div>
        {event.enrollmentId && (
          <div>
            <dt>{t("auditView.technical.enrollment")}</dt>
            <dd className="mono" dir="ltr">
              {event.enrollmentId}
            </dd>
          </div>
        )}
      </dl>
      {event.payload && !event.payloadWithheld && (
        <AuditPayload payload={event.payload} />
      )}
    </TechnicalDetails>
  );
}

/** A recorded payload as its fields (name, then value), not as one line of JSON. */
function AuditPayload({ payload }: { payload: unknown }) {
  const t = useT();
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return (
      <code className="audit-payload" dir="ltr">
        {JSON.stringify(payload)}
      </code>
    );
  const entries = Object.entries(payload as Record<string, unknown>);
  if (!entries.length)
    return <p className="muted">{t("auditView.technical.none")}</p>;
  return (
    <dl className="audit-fields">
      {entries.map(([name, value]) => (
        <div key={name}>
          <dt dir="ltr">{name}</dt>
          <dd className="mono" dir="ltr">
            {typeof value === "string" ? value : JSON.stringify(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
