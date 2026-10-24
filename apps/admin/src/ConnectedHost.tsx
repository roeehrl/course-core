import { useEffect, useMemo, useRef, useState } from "react";
import { Fingerprint, Globe, KeyRound, Languages, LogOut } from "lucide-react";
import {
  isSupportedLocale,
  localeInfo,
  type AppLocale,
} from "@course-core/i18n";
import { AdminApp } from "./AdminApp";
import { createFetchAdminClient } from "./client/fetchClient";
import { useRemote } from "./hooks/useAdmin";
import {
  Button,
  Dialog,
  Loading,
  Notice,
  ToastRegion,
  type ToastMessage,
} from "./components/ui";
import { ChangePasswordForm, SignInCard } from "./SignIn";
import { PasskeysPanel, passkeysSupported } from "./Passkeys";
import { LocaleSwitcher } from "./components/LocaleSwitcher";
import { AccountMenu, type AccountMenuGroup } from "./components/AccountMenu";
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
    // One account dialog at a time: opening another replaces it.
    [panel, setPanel] = useState<
      "password" | "passkeys" | "workspaceLanguage" | null
    >(null),
    [saving, setSaving] = useState(false),
    [ownedWorkspaces, setOwnedWorkspaces] = useState<OwnedWorkspace[]>([]),
    [toast, setToast] = useState<ToastMessage | null>(null);
  const toastId = useRef(0);
  const say = (tone: ToastMessage["tone"], message: ToastMessage["message"]) =>
    setToast({ id: ++toastId.current, tone, message });
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
      say("red", "connectedHost.languageSaveFailed"),
    );
  };
  const closePanel = () => {
    setSaving(false);
    setPanel(null);
  };
  async function signOut() {
    setPending(true);
    setToast(null);
    try {
      const response = await fetch("/auth/logout", {
        method: "POST",
        credentials: "include",
        headers: csrfHeaders(),
      });
      if (!response.ok) throw new Error();
      closePanel();
      setGeneration((value) => value + 1);
    } catch {
      say("red", "connectedHost.signOutFailed");
    } finally {
      setPending(false);
    }
  }
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
  const open = (next: NonNullable<typeof panel>) => () => {
    setToast(null);
    setSaving(false);
    setPanel(next);
  };
  const groups: AccountMenuGroup[] = [
    {
      id: "language",
      label: t("localeSwitcher.label"),
      icon: Languages,
      items: localeControl.available.map((locale) => ({
        kind: "radio" as const,
        id: `language:${locale}`,
        label: localeInfo(locale).nativeName,
        lang: locale,
        dir: localeInfo(locale).dir,
        checked: locale === localeControl.locale,
        onSelect: () => {
          if (locale === localeControl.locale) return;
          localeControl.choose(locale);
          saveLocale(locale);
        },
      })),
    },
    {
      id: "settings",
      items: [
        ...(ownedWorkspaces.length > 0
          ? [
              {
                kind: "action" as const,
                id: "workspaceLanguage",
                label: t("connectedHost.workspaceLanguage"),
                icon: Globe,
                opensDialog: true,
                disabled: pending,
                onSelect: open("workspaceLanguage"),
              },
            ]
          : []),
        ...(user.hasPassword
          ? [
              {
                kind: "action" as const,
                id: "password",
                label: t("connectedHost.changePassword"),
                icon: KeyRound,
                opensDialog: true,
                disabled: pending,
                onSelect: open("password"),
              },
            ]
          : []),
        ...(passkeysSupported()
          ? [
              {
                kind: "action" as const,
                id: "passkeys",
                label: t("connectedHost.passkeys"),
                icon: Fingerprint,
                opensDialog: true,
                disabled: pending,
                onSelect: open("passkeys"),
              },
            ]
          : []),
      ],
    },
    {
      id: "session",
      items: [
        {
          kind: "action",
          id: "signOut",
          label: t("connectedHost.signOut"),
          icon: LogOut,
          disabled: pending,
          onSelect: () => void signOut(),
        },
      ],
    },
  ];
  const eyebrow = t("connectedHost.accountEyebrow");
  return (
    <>
      <AdminApp
        key={generation}
        client={client}
        account={
          <AccountMenu
            name={user.displayName}
            detail={user.loginName}
            groups={groups}
          />
        }
      />
      {panel === "password" && (
        <Dialog
          title={t("signIn.change.title")}
          eyebrow={eyebrow}
          className="account-dialog"
          pending={saving}
          onClose={closePanel}
        >
          <ChangePasswordForm
            loginName={user.loginName}
            headers={csrfHeaders}
            onPendingChange={setSaving}
            onClose={(changed) => {
              closePanel();
              if (changed) say("green", "connectedHost.passwordChanged");
            }}
          />
        </Dialog>
      )}
      {panel === "workspaceLanguage" && (
        <Dialog
          title={t("workspaceLocaleSetting.title")}
          eyebrow={t("connectedHost.workspaceEyebrow")}
          className="account-dialog"
          onClose={closePanel}
        >
          <WorkspaceLocaleSetting
            workspaces={ownedWorkspaces}
            headers={csrfHeaders}
            onClose={closePanel}
          />
        </Dialog>
      )}
      {panel === "passkeys" && (
        <Dialog
          title={t("passkeys.title")}
          eyebrow={eyebrow}
          className="account-dialog"
          pending={saving}
          onClose={closePanel}
        >
          <PasskeysPanel
            loginName={user.loginName}
            hasPassword={user.hasPassword === true}
            headers={csrfHeaders}
            onPendingChange={setSaving}
            onClose={closePanel}
          />
        </Dialog>
      )}
      <ToastRegion toast={toast} onDismiss={() => setToast(null)} />
    </>
  );
}
