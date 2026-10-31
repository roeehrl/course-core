import { useId, useState } from "react";
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
  Loading,
  Notice,
} from "../components/ui";
import { useFormatters, useI18n, useT } from "../i18n";
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

function AuditLog({
  port,
  workspaceId,
}: {
  port: NonNullable<AdminClient["audit"]>;
  workspaceId: string;
}) {
  const id = useId();
  const t = useT();
  const [actorKind, setActorKind] = useState<AuditQuery["actorKind"] | "">("");
  const [pages, setPages] = useState<string[]>([]);
  const before = pages.at(-1);
  const page = useRemote(
    (signal) =>
      port.list(
        workspaceId,
        {
          ...(before ? { before } : {}),
          ...(actorKind ? { actorKind } : {}),
          limit: 50,
        },
        signal,
      ),
    [port, workspaceId, actorKind, before],
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
        </div>
        {page.loading ? (
          <Loading label={t("auditView.loading")} />
        ) : page.error || !page.data ? (
          <Notice tone="red">{overviewErrorMessage(page.error, t)}</Notice>
        ) : page.data.events.length === 0 ? (
          <EmptyState title={t("auditView.empty.title")}>
            {t("auditView.empty.body")}
          </EmptyState>
        ) : (
          <AuditTable page={page.data} />
        )}
        <div className="tag-row">
          {pages.length > 0 && (
            <Button onClick={() => setPages(pages.slice(0, -1))}>
              {t("auditView.newer")}
            </Button>
          )}
          {page.data?.nextBefore && (
            <Button
              onClick={() => setPages([...pages, page.data!.nextBefore!])}
            >
              {t("auditView.older")}
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
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
        <thead>
          <tr>
            <th scope="col">{t("auditView.table.event")}</th>
            <th scope="col">{t("auditView.table.who")}</th>
            <th scope="col">{t("auditView.table.when")}</th>
            <th scope="col">{t("auditView.table.details")}</th>
          </tr>
        </thead>
        <tbody>
          {page.events.map((e) => (
            <tr key={e.id}>
              <th scope="row" className="mono">
                <span dir="ltr">{e.type}</span>
              </th>
              <td data-label={t("auditView.table.who")}>
                <span className="audit-who">
                  <Badge tone={e.actorKind === "staff" ? "blue" : "neutral"}>
                    {i18n.has(`auditView.actorKind.${e.actorKind}`)
                      ? t(`auditView.actorKind.${e.actorKind}`)
                      : e.actorKind}
                  </Badge>
                  {e.actor && <bdi>{e.actor}</bdi>}
                </span>
              </td>
              <td className="cell-date" data-label={t("auditView.table.when")}>
                {when(e.at)}
              </td>
              <td data-label={t("auditView.table.details")}>
                {e.payloadWithheld ? (
                  <span className="muted">
                    {e.enrollmentId
                      ? t("auditView.withheldLearner")
                      : t("auditView.withheld")}
                  </span>
                ) : (
                  <AuditPayload payload={e.payload} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A recorded payload as its fields (name, then value), not as one line of JSON. */
function AuditPayload({ payload }: { payload: unknown }) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return (
      <code className="audit-payload" dir="ltr">
        {JSON.stringify(payload)}
      </code>
    );
  const entries = Object.entries(payload as Record<string, unknown>);
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
