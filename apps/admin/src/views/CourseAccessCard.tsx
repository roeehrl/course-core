import { useId, useRef, useState } from "react";
import { CalendarClock } from "lucide-react";
import type { AdminClient } from "../domain/contracts";
import {
  grantableRoles,
  peopleErrorMessage,
  roleLabel,
  type GrantableRole,
  type Person,
} from "../domain/people";
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
import { randomId } from "../domain/webCrypto";
import { useFormatters, useI18n, type MessageKey } from "../i18n";

type Port = NonNullable<AdminClient["people"]>;
const REASON = /^[a-z][a-z0-9_]{0,63}$/;

/** Time-limited access to this one course for people whose workspace role is course_scoped.
 * The server checks the grant on every request: expiry and revocation end access at once. */
export function CourseAccessCard({
  port,
  workspaceId,
  course,
  people,
}: {
  port: Port;
  workspaceId: string;
  course: { id: string; title: string };
  people: Person[];
}) {
  const i18n = useI18n();
  const t = i18n.t;
  const { when } = useFormatters();
  const scopedRole = roleLabel("course_scoped", t);
  const id = useId();
  const list = useRemote(
    (signal) => port.grants!(workspaceId, signal),
    [port, workspaceId],
  );
  const scoped = people.filter((p) => p.role === "course_scoped" && !p.self);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<GrantableRole>("observer");
  const [days, setDays] = useState("30");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [message, setMessage] = useState("");
  const keys = useRef(new Map<string, string>());
  const keyFor = (fingerprint: string) => {
    let key = keys.current.get(fingerprint);
    if (!key) keys.current.set(fingerprint, (key = "grant-" + randomId()));
    return key;
  };
  async function run(
    fingerprint: string,
    command: (key: string) => Promise<unknown>,
    success: string,
  ) {
    setPending(true);
    setError(undefined);
    setMessage("");
    try {
      await command(keyFor(fingerprint));
      keys.current.delete(fingerprint);
      setMessage(success);
      list.reload();
      return true;
    } catch (caught) {
      setError(caught);
      return false;
    } finally {
      setPending(false);
    }
  }
  const name = (userId: string) =>
    people.find((p) => p.userId === userId)?.displayName ??
    t("courseAccessCard.formerMember");
  const dayCount = Number(days);
  const valid =
    userId &&
    REASON.test(reason) &&
    Number.isInteger(dayCount) &&
    dayCount >= 1 &&
    dayCount <= 365;
  const grants = (list.data?.grants ?? []).filter(
    (g) => g.catalogId === course.id,
  );
  return (
    <Card
      title={t("courseAccessCard.title", { course: course.title })}
      eyebrow={t("courseAccessCard.eyebrow")}
    >
      <p className="muted">
        {i18n.rich(
          "courseAccessCard.intro",
          { role: scopedRole },
          {
            role: (children, key) => (
              <span key={key} className="mono">
                {children}
              </span>
            ),
          },
        )}
      </p>
      <div aria-live="polite">
        {message && <Notice tone="green">{message}</Notice>}
        {error !== undefined && (
          <Notice tone="red">{peopleErrorMessage(error, t)}</Notice>
        )}
      </div>
      {scoped.length === 0 ? (
        <Notice tone="blue">
          {t("courseAccessCard.noScoped", { role: scopedRole })}
        </Notice>
      ) : (
        <form
          className="input-grid grant-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            const input = {
              userId,
              catalogId: course.id,
              role,
              expiresAt: new Date(
                Date.now() + dayCount * 86_400_000,
              ).toISOString(),
              reasonCode: reason,
            };
            void run(
              `grant:${userId}:${course.id}:${role}:${days}:${reason}`,
              (key) => port.grant!(workspaceId, input, key),
              t("courseAccessCard.granted", {
                name: name(userId),
                course: course.title,
                role: roleLabel(role, t),
                days: dayCount,
              }),
            ).then((done) => done && setReason(""));
          }}
        >
          <Field label={t("courseAccessCard.person")} htmlFor={`${id}-person`}>
            <select
              id={`${id}-person`}
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
            >
              <option value="">{t("courseAccessCard.choosePerson")}</option>
              {scoped.map((p) => (
                <option key={p.userId} value={p.userId} dir="auto">
                  {p.displayName}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label={t("courseAccessCard.roleOnCourse")}
            htmlFor={`${id}-role`}
          >
            <select
              id={`${id}-role`}
              value={role}
              onChange={(e) => setRole(e.target.value as GrantableRole)}
            >
              {grantableRoles.map((r) => (
                <option key={r} value={r}>
                  {roleLabel(r, t)}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label={t("courseAccessCard.days")}
            htmlFor={`${id}-days`}
            hint={t("courseAccessCard.days.hint")}
          >
            <input
              id={`${id}-days`}
              type="number"
              min={1}
              max={365}
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
          </Field>
          <Field
            label={t("courseAccessCard.reasonCode")}
            htmlFor={`${id}-reason`}
            hint={t("courseAccessCard.reasonCode.hint", {
              example: "support_case",
            })}
          >
            <input
              id={`${id}-reason`}
              dir="ltr"
              value={reason}
              maxLength={64}
              onChange={(e) => setReason(e.target.value.trim())}
            />
          </Field>
          <div className="wide">
            <Button kind="primary" type="submit" disabled={pending || !valid}>
              <CalendarClock size={16} aria-hidden="true" />{" "}
              {t("courseAccessCard.grant")}
            </Button>
          </div>
        </form>
      )}
      {list.loading ? (
        <Loading label={t("courseAccessCard.loading")} />
      ) : list.error ? (
        <Notice tone="red">{peopleErrorMessage(list.error, t)}</Notice>
      ) : grants.length === 0 ? (
        <EmptyState title={t("courseAccessCard.empty.title")}>
          {t("courseAccessCard.empty.body")}
        </EmptyState>
      ) : (
        <div
          className="table-wrap"
          tabIndex={0}
          role="region"
          aria-label={t("courseAccessCard.grants")}
        >
          <table className="people-table">
            <caption className="sr-only">
              {t("courseAccessCard.grants")}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t("courseAccessCard.person")}</th>
                <th scope="col">{t("courseAccessCard.column.role")}</th>
                <th scope="col">{t("courseAccessCard.column.access")}</th>
                <th scope="col">
                  <span className="sr-only">
                    {t("courseAccessCard.column.actions")}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {grants.map((g) => (
                <tr key={g.grantId}>
                  <th scope="row">
                    <bdi>{name(g.userId)}</bdi>
                    <small className="people-meta mono" dir="ltr">
                      {g.reasonCode}
                    </small>
                  </th>
                  <td data-label={t("courseAccessCard.column.role")}>
                    <Badge>{roleLabel(g.role, t)}</Badge>
                  </td>
                  <td data-label={t("courseAccessCard.column.access")}>
                    <Badge tone={g.state === "active" ? "green" : "neutral"}>
                      {t(`courseAccessCard.state.${g.state}` as MessageKey)}
                    </Badge>{" "}
                    <small>
                      {g.state === "revoked"
                        ? t("courseAccessCard.revokedAt", {
                            date: when(g.revokedAt!),
                            reason: g.revokeReasonCode ?? "",
                          })
                        : g.state === "active"
                          ? t("courseAccessCard.until", {
                              date: when(g.expiresAt),
                            })
                          : t("courseAccessCard.ended", {
                              date: when(g.expiresAt),
                            })}
                    </small>
                  </td>
                  <td className="people-actions">
                    {g.state === "active" && (
                      <Button
                        kind="danger"
                        disabled={pending}
                        onClick={() =>
                          void run(
                            `revoke:${g.grantId}`,
                            (key) =>
                              port.revokeGrant!(
                                workspaceId,
                                g.grantId,
                                "access_ended",
                                key,
                              ),
                            t("courseAccessCard.revoked", {
                              name: name(g.userId),
                            }),
                          )
                        }
                      >
                        {t("courseAccessCard.revoke", { name: name(g.userId) })}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
