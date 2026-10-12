import { useMemo, useState } from "react";
import { AdminApp } from "./AdminApp";
import { createFetchAdminClient } from "./client/fetchClient";
import { useRemote } from "./hooks/useAdmin";
import { Button, Card, Field, Loading, Notice } from "./components/ui";

export function csrfHeaders(): HeadersInit {
  const value = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("course_csrf="))
    ?.slice("course_csrf=".length);
  return value ? { "X-CSRF-Token": decodeURIComponent(value) } : {};
}
/** Same-origin cookie session. No API keys, demo fallback or browser-stored learner data. */
export function ConnectedHost() {
  const [generation, setGeneration] = useState(0);
  const session = useRemote(
    async (signal) => {
      const response = await fetch("/auth/session", {
        credentials: "include",
        cache: "no-store",
        signal,
      });
      if (response.status === 401) return false;
      if (!response.ok) throw new Error("Session unavailable");
      return true;
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
  const [code, setCode] = useState(""),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  if (session.loading)
    return (
      <main className="startup">
        <Loading label="Checking your secure session…" />
      </main>
    );
  if (session.error)
    return (
      <main className="startup">
        <Notice tone="red">
          The server connection is unavailable. No demo data has been
          substituted.
        </Notice>
        <Button onClick={session.reload}>Retry connection</Button>
      </main>
    );
  if (!session.data)
    return (
      <main className="startup">
        <Card title="Sign in to administration" eyebrow="Course Core">
          <p>
            Use a one-time sign-in code issued by your workspace administrator.
            Access is determined by your workspace membership.
          </p>
          <form
            className="stack"
            onSubmit={async (event) => {
              event.preventDefault();
              if (pending) return;
              setPending(true);
              setError("");
              try {
                const response = await fetch("/auth/redeem", {
                  method: "POST",
                  credentials: "include",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ token: code }),
                });
                if (!response.ok) throw new Error();
                setCode("");
                setGeneration((value) => value + 1);
              } catch {
                setError(
                  "The code could not be redeemed. Check the code or request a new one.",
                );
              } finally {
                setPending(false);
              }
            }}
          >
            <Field label="One-time sign-in code" htmlFor="login-code">
              <input
                id="login-code"
                type="password"
                autoComplete="off"
                required
                pattern="[A-Za-z0-9_\-]{43}"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                disabled={pending}
              />
            </Field>
            {error && <Notice tone="red">{error}</Notice>}
            <Button type="submit" kind="primary" disabled={pending}>
              {pending ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </Card>
      </main>
    );
  return (
    <>
      <div className="connection-bar">
        <span>Connected to your workspace · authenticated session</span>
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
        {error && <Notice tone="red">{error}</Notice>}
      </div>
      <AdminApp key={generation} client={client} />
    </>
  );
}
