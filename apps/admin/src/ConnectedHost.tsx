import { useEffect, useMemo, useState } from "react";
import { isSupportedLocale, type AppLocale } from "@course-core/i18n";
import { AdminApp } from "./AdminApp";
import { createFetchAdminClient } from "./client/fetchClient";
import { useRemote } from "./hooks/useAdmin";
import { Button, Loading, Notice } from "./components/ui";
import { ChangePasswordCard, SignInCard } from "./SignIn";
import { PasskeysCard, passkeysSupported } from "./Passkeys";
import { LocaleSwitcher } from "./components/LocaleSwitcher";
import {
  WorkspaceLocaleSetting,
  type OwnedWorkspace,
} from "./components/WorkspaceLocaleSetting";
import { useT } from "./i18n";
import { useLocaleControl } from "./i18n/LocaleProvider";
import { fetchServerLocale, saveServerLocale } from "./i18n/localeApi";

export function csrfHeaders(): HeadersInit {
  const value = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("course_csrf="))
    ?.slice("course_csrf=".length);
  return value ? { "X-CSRF-Token": decodeURIComponent(value) } : {};
}
interface SessionUser {
  id: string;
  displayName: string;
  loginName?: string | null;
  hasPassword?: boolean;
}
/** Same-origin cookie session. No API keys, demo fallback or browser-stored learner data. */
export function ConnectedHost() {
  const t = useT();
  const localeControl = useLocaleControl();
  const [generation, setGeneration] = useState(0);
  const session = useRemote(
    async (
      signal,
    ): Promise<{
      user?: SessionUser;
      loginCodes: boolean;
      passkeys: boolean;
    }> => {
      const response = await fetch("/auth/session", {
        credentials: "include",
        cache: "no-store",
        signal,
      });
      if (response.status === 401) {
        // Signed out: offer one-time codes only when the server enables them.
        const options = await fetch("/auth/options", {
          credentials: "include",
          cache: "no-store",
          signal,
        })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);
        return {
          loginCodes: options?.loginCodes === true,
          passkeys: options?.passkeys === true,
        };
      }
      if (!response.ok) throw new Error("SESSION_UNAVAILABLE");
      const data = (await response.json().catch(() => null)) as {
        user?: SessionUser;
      } | null;
      return {
        user: data?.user ?? { id: "", displayName: "" },
        loginCodes: false,
        passkeys: false,
      };
    },
    [generation],
  );
  const client = useMemo(
    () =>
      createFetchAdminClient({
        baseUrl: "/api/admin",
        requestHeaders: csrfHeaders,
      }),
    [],
  );
  const [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [changingPassword, setChangingPassword] = useState(false),
    [managingPasskeys, setManagingPasskeys] = useState(false),
    [managingLanguage, setManagingLanguage] = useState(false),
    [ownedWorkspaces, setOwnedWorkspaces] = useState<OwnedWorkspace[]>([]),
    [notice, setNotice] = useState("");
  const userId = session.data?.user?.id;
  // After sign-in: apply the saved preference, or save the choice made on this device.
  useEffect(() => {
    if (!userId) return;
    let live = true;
    fetchServerLocale()
      .then((server) => {
        if (!live) return;
        const save = localeControl.adoptServer(server);
        if (save) void saveServerLocale(save, csrfHeaders()).catch(() => {});
      })
      .catch(() => {});
    fetch("/api/workspaces", { credentials: "include", cache: "no-store" })
      .then((response) => (response.ok ? response.json() : []))
      .then((rows: { id: string; title: string; role: string }[]) => {
        if (live)
          setOwnedWorkspaces(
            rows
              .filter((row) => row.role === "owner")
              .map(({ id, title }) => ({ id, title })),
          );
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // Once per signed-in user.
  }, [userId]);
  const saveLocale = (locale: AppLocale) => {
    if (!userId || !isSupportedLocale(locale)) return;
    saveServerLocale(locale, csrfHeaders()).catch(() =>
      setError(t("connectedHost.languageSaveFailed")),
    );
  };
  if (session.loading)
    return (
      <main className="startup">
        <Loading label={t("connectedHost.checkingSession")} />
      </main>
    );
  if (session.error || !session.data)
    return (
      <main className="startup">
        <Notice tone="red">{t("connectedHost.unavailable")}</Notice>
        <Button onClick={session.reload}>{t("connectedHost.retry")}</Button>
      </main>
    );
  const user = session.data.user;
  if (!user)
    return (
      <main className="startup">
        <LocaleSwitcher />
        <SignInCard
          loginCodes={session.data.loginCodes}
          passkeys={session.data.passkeys}
          onSignedIn={() => setGeneration((value) => value + 1)}
        />
      </main>
    );
  return (
    <>
      <div className="connection-bar">
        <span>{t("connectedHost.connected")}</span>
        <div className="tag-row">
          <LocaleSwitcher onChosen={saveLocale} />
          {ownedWorkspaces.length > 0 && (
            <Button
              kind="quiet"
              disabled={pending || managingLanguage}
              onClick={() => {
                setNotice("");
                setManagingLanguage(true);
              }}
            >
              {t("connectedHost.workspaceLanguage")}
            </Button>
          )}
          {user.hasPassword && (
            <Button
              kind="quiet"
              disabled={pending || changingPassword}
              onClick={() => {
                setNotice("");
                setChangingPassword(true);
              }}
            >
              {t("connectedHost.changePassword")}
            </Button>
          )}
          {passkeysSupported() && (
            <Button
              kind="quiet"
              disabled={pending || managingPasskeys}
              onClick={() => {
                setNotice("");
                setManagingPasskeys(true);
              }}
            >
              {t("connectedHost.passkeys")}
            </Button>
          )}
          <Button
            kind="quiet"
            disabled={pending}
            onClick={async () => {
              setPending(true);
              try {
                const response = await fetch("/auth/logout", {
                  method: "POST",
                  credentials: "include",
                  headers: csrfHeaders(),
                });
                if (!response.ok) throw new Error();
                setChangingPassword(false);
                setManagingPasskeys(false);
                setManagingLanguage(false);
                setGeneration((value) => value + 1);
              } catch {
                setError(t("connectedHost.signOutFailed"));
              } finally {
                setPending(false);
              }
            }}
          >
            {t("connectedHost.signOut")}
          </Button>
        </div>
        {error && <Notice tone="red">{error}</Notice>}
        {notice && <Notice tone="green">{notice}</Notice>}
      </div>
      {changingPassword && (
        <div className="change-password-wrap">
          <ChangePasswordCard
            loginName={user.loginName}
            headers={csrfHeaders}
            onClose={(changed) => {
              setChangingPassword(false);
              if (changed)
                setNotice(t("connectedHost.passwordChanged"));
            }}
          />
        </div>
      )}
      {managingLanguage && (
        <div className="change-password-wrap">
          <WorkspaceLocaleSetting
            workspaces={ownedWorkspaces}
            headers={csrfHeaders}
            onClose={() => setManagingLanguage(false)}
          />
        </div>
      )}
      {managingPasskeys && (
        <div className="change-password-wrap">
          <PasskeysCard
            loginName={user.loginName}
            hasPassword={user.hasPassword === true}
            headers={csrfHeaders}
            onClose={() => setManagingPasskeys(false)}
          />
        </div>
      )}
      <AdminApp key={generation} client={client} />
    </>
  );
}
