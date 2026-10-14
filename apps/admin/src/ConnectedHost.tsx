import { useMemo, useState } from "react";
import { AdminApp } from "./AdminApp";
import { createFetchAdminClient } from "./client/fetchClient";
import { useRemote } from "./hooks/useAdmin";
import { Button, Loading, Notice } from "./components/ui";
import { ChangePasswordCard, SignInCard } from "./SignIn";

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
  const [generation, setGeneration] = useState(0);
  const session = useRemote(
    async (signal): Promise<{ user?: SessionUser; loginCodes: boolean }> => {
      const response = await fetch("/auth/session", {
        credentials: "include",
        cache: "no-store",
        signal,
      });
      if (response.status === 401) {
        // Signed out: offer one-time codes only when the server enables them.
        const options = await fetch("/auth/options", { credentials: "include", cache: "no-store", signal })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);
        return { loginCodes: options?.loginCodes === true };
      }
      if (!response.ok) throw new Error("Session unavailable");
      const data = (await response.json().catch(() => null)) as { user?: SessionUser } | null;
      return { user: data?.user ?? { id: "", displayName: "" }, loginCodes: false };
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
    [notice, setNotice] = useState("");
  if (session.loading)
    return (
      <main className="startup">
        <Loading label="Checking your secure session…" />
      </main>
    );
  if (session.error || !session.data)
    return (
      <main className="startup">
        <Notice tone="red">
          The server connection is unavailable. No demo data has been
          substituted.
        </Notice>
        <Button onClick={session.reload}>Retry connection</Button>
      </main>
    );
  const user = session.data.user;
  if (!user)
    return (
      <main className="startup">
        <SignInCard
          loginCodes={session.data.loginCodes}
          onSignedIn={() => setGeneration((value) => value + 1)}
        />
      </main>
    );
  return (
    <>
      <div className="connection-bar">
        <span>Connected to your workspace · authenticated session</span>
        <div className="tag-row">
          {user.hasPassword && (
            <Button
              kind="quiet"
              disabled={pending || changingPassword}
              onClick={() => {
                setNotice("");
                setChangingPassword(true);
              }}
            >
              Change password
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
                setGeneration((value) => value + 1);
              } catch {
                setError(
                  "Sign-out failed. Retry when the connection is available.",
                );
              } finally {
                setPending(false);
              }
            }}
          >
            Sign out
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
                setNotice(
                  "Your password was changed. Your other sessions were signed out.",
                );
            }}
          />
        </div>
      )}
      <AdminApp key={generation} client={client} />
    </>
  );
}
