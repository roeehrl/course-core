import { useId, useRef, useState } from "react";
import { KeyRound, LockKeyhole, UserMinus, UserPlus } from "lucide-react";
import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import {
  LOGIN_NAME_SYMBOLS,
  peopleErrorMessage,
  roleDescription,
  roleLabel,
  roles,
  type Person,
  type Role,
  type SignInReceipt,
} from "../domain/people";
import { useRemote } from "../hooks/useAdmin";
import { CourseAccessCard } from "./CourseAccessCard";
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  Loading,
  Notice,
} from "../components/ui";
import { randomId } from "../domain/webCrypto";
import { useFormatters, useI18n, useT } from "../i18n";

type Port = NonNullable<AdminClient["people"]>;
const assignable = (actorRole: Role) =>
  roles.filter(
    (r) => actorRole === "owner" || !["owner", "admin", "service"].includes(r),
  );

export function PeopleView({
  data,
  client,
}: {
  data: CourseWorkspace;
  client: AdminClient;
}) {
  const t = useT();
  if (!client.people)
    return (
      <Card title={t("peopleView.title")}>
        <EmptyState title={t("peopleView.unavailable.title")}>
          {t("peopleView.unavailable.body")}
        </EmptyState>
      </Card>
    );
  if (!data.course.workspaceId)
    return (
      <Card title={t("peopleView.title")}>
        <EmptyState title={t("peopleView.noWorkspace.title")}>
          {t("peopleView.noWorkspace.body")}
        </EmptyState>
      </Card>
    );
  return (
    <PeopleAdministration
      port={client.people}
      workspaceId={data.course.workspaceId}
      course={{ id: data.course.id, title: data.course.title }}
    />
  );
}

function PeopleAdministration({
  port,
  workspaceId,
  course,
}: {
  port: Port;
  workspaceId: string;
  course: { id: string; title: string };
}) {
  const i18n = useI18n();
  const t = i18n.t;
  const { when } = useFormatters();
  const list = useRemote(
    (signal) => port.list(workspaceId, signal),
    [port, workspaceId],
  );
  const keys = useRef(new Map<string, string>());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [message, setMessage] = useState<string>();
  const [issued, setIssued] = useState<{
    name: string;
    receipt: SignInReceipt;
  }>();
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<Person>();
  const [settingPassword, setSettingPassword] = useState<Person>();
  const [roleDraft, setRoleDraft] = useState<Record<string, Role>>({});
  async function run<T>(
    fingerprint: string,
    command: (key: string) => Promise<T>,
    success: string,
  ) {
    if (pending) return;
    let key = keys.current.get(fingerprint);
    if (!key) {
      key = "admin-" + randomId();
      keys.current.set(fingerprint, key);
    }
    setPending(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const result = await command(key);
      keys.current.delete(fingerprint);
      setMessage(success);
      list.reload();
      return result;
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  }
  if (list.loading) return <Loading label={t("peopleView.loading")} />;
  if (list.error || !list.data)
    return <Notice tone="red">{peopleErrorMessage(list.error, t)}</Notice>;
  const { actorRole, people } = list.data;
  const loginCodes = list.data.loginCodes === true;
  return (
    <div className="page-stack">
      <Notice tone="blue" title={t("peopleView.access.title")}>
        {loginCodes
          ? t("peopleView.access.bodyWithCodes")
          : t("peopleView.access.body")}
      </Notice>
      <div aria-live="polite">
        {message && <Notice tone="green">{message}</Notice>}
        {error !== undefined && (
          <Notice tone="red">{peopleErrorMessage(error, t)}</Notice>
        )}
      </div>
      {issued?.receipt.signIn && (
        <Card
          title={t("peopleView.issued.code.title", { name: issued.name })}
          eyebrow={t("peopleView.issued.eyebrow")}
        >
          <p>
            {i18n.rich(
              "peopleView.issued.code.body",
              {
                minutes: issued.receipt.signIn.expiresInMinutes,
                path: issued.receipt.signIn.adminPath,
              },
              {
                path: (children, key) => (
                  <span key={key} className="mono" dir="ltr">
                    {children}
                  </span>
                ),
              },
            )}
          </p>
          <Field label={t("peopleView.issued.link")} htmlFor="issued-link">
            <input
              id="issued-link"
              dir="ltr"
              readOnly
              value={issued.receipt.signIn.learnerUrl}
              onFocus={(e) => e.currentTarget.select()}
            />
          </Field>
          <Field label={t("peopleView.issued.code")} htmlFor="issued-code">
            <input
              id="issued-code"
              dir="ltr"
              readOnly
              className="mono"
              value={issued.receipt.signIn.code}
              onFocus={(e) => e.currentTarget.select()}
            />
          </Field>
          <Button onClick={() => setIssued(undefined)}>
            {t("peopleView.issued.hideCode")}
          </Button>
        </Card>
      )}
      {issued?.receipt.password && (
        <Card
          title={t("peopleView.password.title", { name: issued.name })}
          eyebrow={t("peopleView.issued.eyebrow")}
        >
          <p>
            {i18n.rich(
              "peopleView.issued.password.body",
              { path: issued.receipt.password.adminPath },
              {
                path: (children, key) => (
                  <span key={key} className="mono" dir="ltr">
                    {children}
                  </span>
                ),
              },
            )}
          </p>
          <Field label={t("peopleView.username")} htmlFor="issued-login">
            <input
              id="issued-login"
              dir="ltr"
              readOnly
              className="mono"
              value={issued.receipt.password.loginName}
              onFocus={(e) => e.currentTarget.select()}
            />
          </Field>
          <Field
            label={t("peopleView.temporaryPassword")}
            htmlFor="issued-password"
          >
            <input
              id="issued-password"
              dir="ltr"
              readOnly
              autoComplete="off"
              className="mono"
              value={issued.receipt.password.temporaryPassword}
              onFocus={(e) => e.currentTarget.select()}
            />
          </Field>
          <Button onClick={() => setIssued(undefined)}>
            {t("peopleView.issued.hidePassword")}
          </Button>
        </Card>
      )}
      {issued && !issued.receipt.signIn && !issued.receipt.password && (
        <Notice tone="gold">{t("peopleView.issued.replayed")}</Notice>
      )}
      <Card
        title={t("peopleView.members.title")}
        eyebrow={t("peopleView.members.count", { count: people.length })}
        actions={
          <Button
            kind="primary"
            disabled={pending}
            onClick={() => setInviting(true)}
          >
            <UserPlus size={16} aria-hidden="true" /> {t("peopleView.invite")}
          </Button>
        }
      >
        <div className="table-wrap">
          <table className="people-table">
            <caption className="sr-only">
              {t("peopleView.members.caption")}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t("peopleView.column.person")}</th>
                <th scope="col">{t("peopleView.column.role")}</th>
                <th scope="col">{t("peopleView.column.enrollments")}</th>
                <th scope="col">{t("peopleView.column.lastSignIn")}</th>
                <th scope="col">
                  <span className="sr-only">
                    {t("peopleView.column.actions")}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {people.map((person) => {
                const draft = roleDraft[person.userId] ?? person.role;
                return (
                  <tr key={person.userId}>
                    <th scope="row">
                      <bdi>{person.displayName}</bdi>
                      {person.self && (
                        <Badge tone="blue">{t("peopleView.badge.you")}</Badge>
                      )}
                      {person.mustChangePassword && (
                        <Badge tone="gold">
                          {t("peopleView.badge.temporaryPassword")}
                        </Badge>
                      )}
                      {person.loginName && (
                        <small className="people-meta mono" dir="ltr">
                          {person.loginName}
                        </small>
                      )}
                      <small className="people-meta">
                        {person.addedBy
                          ? t("peopleView.joinedAddedBy", {
                              date: when(person.joinedAt),
                              name: person.addedBy,
                            })
                          : t("peopleView.joined", {
                              date: when(person.joinedAt),
                            })}
                      </small>
                    </th>
                    <td data-label={t("peopleView.column.role")}>
                      {person.canChangeRole ? (
                        <div className="people-role">
                          <label
                            className="sr-only"
                            htmlFor={`role-${person.userId}`}
                          >
                            {t("peopleView.roleFor", {
                              name: person.displayName,
                            })}
                          </label>
                          <select
                            id={`role-${person.userId}`}
                            value={draft}
                            disabled={pending}
                            onChange={(e) =>
                              setRoleDraft({
                                ...roleDraft,
                                [person.userId]: e.target.value as Role,
                              })
                            }
                          >
                            {assignable(actorRole)
                              .concat(
                                assignable(actorRole).includes(person.role)
                                  ? []
                                  : [person.role],
                              )
                              .map((r) => (
                                <option key={r} value={r}>
                                  {roleLabel(r, t)}
                                </option>
                              ))}
                          </select>
                          {draft !== person.role && (
                            <Button
                              disabled={pending}
                              onClick={() =>
                                void run(
                                  `role:${person.userId}:${person.role}:${draft}`,
                                  (key) =>
                                    port.changeRole(
                                      workspaceId,
                                      person.userId,
                                      {
                                        role: draft,
                                        expectedRole: person.role,
                                      },
                                      key,
                                    ),
                                  t("peopleView.roleChanged", {
                                    name: person.displayName,
                                    role: roleLabel(draft, t),
                                  }),
                                ).then(() =>
                                  setRoleDraft(
                                    ({ [person.userId]: _, ...rest }) => rest,
                                  ),
                                )
                              }
                            >
                              {t("peopleView.saveRole")}
                            </Button>
                          )}
                        </div>
                      ) : (
                        <Badge>{roleLabel(person.role, t)}</Badge>
                      )}
                    </td>
                    <td data-label={t("peopleView.column.enrollments")}>
                      {i18n.number(person.enrollments)}
                    </td>
                    <td data-label={t("peopleView.column.lastSignIn")}>
                      {person.lastSignInAt
                        ? when(person.lastSignInAt)
                        : t("peopleView.never")}
                    </td>
                    <td className="people-actions">
                      <div className="tag-row">
                        {person.canIssueSignIn && (
                          <Button
                            kind="quiet"
                            disabled={pending}
                            onClick={() =>
                              void run(
                                `signin:${person.userId}:${Date.now()}`,
                                (key) =>
                                  port.issueSignIn(
                                    workspaceId,
                                    person.userId,
                                    key,
                                  ),
                                t("peopleView.codeIssued"),
                              ).then(
                                (receipt) =>
                                  receipt &&
                                  setIssued({
                                    name: person.displayName,
                                    receipt,
                                  }),
                              )
                            }
                          >
                            <KeyRound size={16} aria-hidden="true" />{" "}
                            {t("peopleView.newCode")}
                          </Button>
                        )}
                        {person.canSetPassword && (
                          <Button
                            kind="quiet"
                            disabled={pending}
                            onClick={() => setSettingPassword(person)}
                          >
                            <LockKeyhole size={16} aria-hidden="true" />{" "}
                            {t("peopleView.setPassword")}
                          </Button>
                        )}
                        {person.canRevoke && (
                          <Button
                            kind="danger"
                            disabled={pending}
                            onClick={() => setRemoving(person)}
                          >
                            <UserMinus size={16} aria-hidden="true" />{" "}
                            {t("peopleView.remove")}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      {port.grants && port.grant && port.revokeGrant && (
        <CourseAccessCard
          port={port}
          workspaceId={workspaceId}
          course={course}
          people={people}
        />
      )}
      {inviting && (
        <InviteDialog
          actorRole={actorRole}
          loginCodes={loginCodes}
          pending={pending}
          onClose={() => setInviting(false)}
          onSubmit={async (input) => {
            const receipt = await run(
              `invite:${input.displayName}:${input.role}:${input.loginName ?? ""}`,
              (key) => port.invite(workspaceId, input, key),
              t("peopleView.invited", {
                name: input.displayName,
                role: roleLabel(input.role, t),
              }),
            );
            if (receipt) {
              setIssued({ name: input.displayName, receipt });
              setInviting(false);
            }
          }}
        />
      )}
      {settingPassword && (
        <PasswordDialog
          person={settingPassword}
          pending={pending}
          onClose={() => setSettingPassword(undefined)}
          onSubmit={async (loginName) => {
            const person = settingPassword;
            const receipt = await run(
              `password:${person.userId}:${Date.now()}`,
              (key) =>
                port.setPassword(
                  workspaceId,
                  person.userId,
                  { loginName },
                  key,
                ),
              t("peopleView.passwordSet", { name: person.displayName }),
            );
            if (receipt) {
              setIssued({ name: person.displayName, receipt });
              setSettingPassword(undefined);
            }
          }}
        />
      )}
      {removing && (
        <RemoveDialog
          person={removing}
          pending={pending}
          onClose={() => setRemoving(undefined)}
          onSubmit={async (reason) => {
            const done = await run(
              `remove:${removing.userId}:${reason}`,
              (key) =>
                port.revoke(
                  workspaceId,
                  removing.userId,
                  { expectedRole: removing.role, reason },
                  key,
                ),
              t("peopleView.removed", { name: removing.displayName }),
            );
            if (done) setRemoving(undefined);
          }}
        />
      )}
    </div>
  );
}

function InviteDialog({
  actorRole,
  loginCodes,
  pending,
  onClose,
  onSubmit,
}: {
  actorRole: Role;
  loginCodes: boolean;
  pending: boolean;
  onClose: () => void;
  onSubmit: (input: {
    displayName: string;
    role: Role;
    loginName?: string;
  }) => void;
}) {
  const i18n = useI18n();
  const t = i18n.t;
  const id = useId();
  const [name, setName] = useState("");
  const [login, setLogin] = useState("");
  const [role, setRole] = useState<Role>("learner");
  return (
    <Dialog
      title={t("peopleView.inviteDialog.title")}
      onClose={onClose}
      pending={pending}
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({
            displayName: name.trim(),
            role,
            ...(login.trim() ? { loginName: login.trim() } : {}),
          });
        }}
      >
        <Field
          label={t("peopleView.displayName")}
          htmlFor={id + "-name"}
          hint={t("peopleView.displayName.hint")}
        >
          <input
            id={id + "-name"}
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field
          label={
            loginCodes
              ? t("peopleView.usernameOptional")
              : t("peopleView.username")
          }
          htmlFor={id + "-login"}
          hint={
            loginCodes
              ? t("peopleView.username.hintCodes")
              : t("peopleView.username.hint", { symbols: LOGIN_NAME_SYMBOLS })
          }
        >
          <input
            id={id + "-login"}
            dir="ltr"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            required={!loginCodes}
            maxLength={128}
            value={login}
            onChange={(e) => setLogin(e.target.value)}
          />
        </Field>
        <fieldset className="stack">
          <legend>{t("peopleView.column.role")}</legend>
          {assignable(actorRole).map((r) => (
            <label className="check-label" key={r}>
              <input
                type="radio"
                name={id + "-role"}
                checked={role === r}
                onChange={() => setRole(r)}
              />
              <span>
                {i18n.rich(
                  "peopleView.roleOption",
                  {
                    role: roleLabel(r, t),
                    description: roleDescription(r, t),
                  },
                  {
                    role: (children, key) => (
                      <strong key={key}>{children}</strong>
                    ),
                  },
                )}
              </span>
            </label>
          ))}
        </fieldset>
        <div className="tag-row">
          <Button
            kind="primary"
            type="submit"
            disabled={pending || !name.trim() || (!loginCodes && !login.trim())}
          >
            {login.trim()
              ? t("peopleView.inviteWithPassword")
              : t("peopleView.inviteWithCode")}
          </Button>
          <Button type="button" onClick={onClose} disabled={pending}>
            {t("peopleView.cancel")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RemoveDialog({
  person,
  pending,
  onClose,
  onSubmit,
}: {
  person: Person;
  pending: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const t = useT();
  const id = useId();
  const [reason, setReason] = useState("");
  return (
    <Dialog
      title={t("peopleView.removeDialog.title", { name: person.displayName })}
      onClose={onClose}
      pending={pending}
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(reason.trim());
        }}
      >
        <p>{t("peopleView.removeDialog.body")}</p>
        <Field
          label={t("peopleView.reason")}
          htmlFor={id + "-reason"}
          hint={t("peopleView.reason.hint")}
        >
          <textarea
            id={id + "-reason"}
            rows={3}
            minLength={10}
            maxLength={1000}
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        <div className="tag-row">
          <Button kind="danger" type="submit" disabled={pending}>
            {t("peopleView.removeAccess")}
          </Button>
          <Button type="button" onClick={onClose} disabled={pending}>
            {t("peopleView.cancel")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function PasswordDialog({
  person,
  pending,
  onClose,
  onSubmit,
}: {
  person: Person;
  pending: boolean;
  onClose: () => void;
  onSubmit: (loginName: string) => void;
}) {
  const t = useT();
  const id = useId();
  const [login, setLogin] = useState(person.loginName ?? "");
  return (
    <Dialog
      title={t("peopleView.password.title", { name: person.displayName })}
      onClose={onClose}
      pending={pending}
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(login.trim());
        }}
      >
        <p>{t("peopleView.passwordDialog.body")}</p>
        <Field
          label={t("peopleView.username")}
          htmlFor={id + "-login"}
          hint={t("peopleView.username.hintShort", {
            symbols: LOGIN_NAME_SYMBOLS,
          })}
        >
          <input
            id={id + "-login"}
            dir="ltr"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            required
            maxLength={128}
            value={login}
            onChange={(e) => setLogin(e.target.value)}
          />
        </Field>
        <div className="tag-row">
          <Button
            kind="primary"
            type="submit"
            disabled={pending || !login.trim()}
          >
            {t("peopleView.createPassword")}
          </Button>
          <Button type="button" onClick={onClose} disabled={pending}>
            {t("peopleView.cancel")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
