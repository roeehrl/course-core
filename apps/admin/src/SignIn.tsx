import { useId, useState } from "react";
import { Button, Card, Field, Notice } from "./components/ui";
import { PasskeySignInButton, passkeysSupported } from "./Passkeys";

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 1024;
const length = (value: string) => Array.from(value.normalize("NFKC")).length;

/** Client-side mirror of the server policy (length only); the server is authoritative. */
export function newPasswordProblem(
  next: string,
  repeat: string,
  previous?: string,
) {
  if (length(next) < PASSWORD_MIN_LENGTH)
    return `Use at least ${PASSWORD_MIN_LENGTH} characters. A few unrelated words make a strong, memorable password.`;
  if (length(next) > PASSWORD_MAX_LENGTH)
    return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  if (next !== repeat) return "The new passwords do not match.";
  if (
    previous !== undefined &&
    next.normalize("NFKC") === previous.normalize("NFKC")
  )
    return "Choose a password different from the current one.";
  return undefined;
}
const authMessages: Record<string, string> = {
  LOGIN_FAILED: "The username or password is incorrect.",
  LOGIN_THROTTLED:
    "Too many unsuccessful attempts. Wait 15 minutes, then try again.",
  AUTH_BUSY: "Sign-in is busy right now. Try again in a moment.",
  PASSWORD_POLICY: `Use a password of ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters.`,
  PASSWORD_UNCHANGED: "Choose a password different from the current one.",
  CURRENT_PASSWORD_INCORRECT: "Your current password is incorrect.",
  PASSWORD_NOT_SET:
    "This account has no password yet. Ask an owner to set one.",
  LOGIN_CODE_INVALID:
    "The code could not be redeemed. Check the code or request a new one.",
  LOGIN_CODES_DISABLED: "One-time sign-in codes are turned off on this server.",
  ORIGIN_REJECTED:
    "This page's address does not match the server's configured origin.",
  CSRF_REJECTED:
    "Your session changed in another tab. Reload the page and try again.",
  UNAUTHENTICATED: "Your session has ended. Sign in again.",
};
export function authErrorMessage(code: string | undefined) {
  return (
    (code && authMessages[code]) ||
    "Sign-in is unavailable. Check your connection and try again."
  );
}
export class AuthRequestError extends Error {
  constructor(readonly code: string | undefined) {
    super(code ?? "AUTH_UNAVAILABLE");
  }
}
export async function postJson(
  url: string,
  body: unknown,
  headers: HeadersInit = {},
) {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AuthRequestError(undefined);
  }
  const data = (await response.json().catch(() => null)) as {
    error?: unknown;
  } | null;
  if (!response.ok)
    throw new AuthRequestError(
      typeof data?.error === "string" ? data.error : undefined,
    );
  return data;
}

/** Username/password sign-in; a temporary password must be replaced before a session
 * exists. The one-time code form appears only when the server enables codes. */
export function SignInCard({
  loginCodes,
  passkeys = false,
  onSignedIn,
}: {
  loginCodes: boolean;
  /** The server's origin can host passkeys; the button also needs browser support. */
  passkeys?: boolean;
  onSignedIn: () => void;
}) {
  const id = useId();
  const [login, setLogin] = useState(""),
    [password, setPassword] = useState(""),
    [next, setNext] = useState(""),
    [repeat, setRepeat] = useState(""),
    [code, setCode] = useState("");
  const [mustChange, setMustChange] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  async function attempt(action: () => Promise<void>) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await action();
    } catch (caught) {
      const code = caught instanceof AuthRequestError ? caught.code : undefined;
      if (code === "PASSWORD_CHANGE_REQUIRED") setMustChange(true);
      else setError(authErrorMessage(code));
    } finally {
      setPending(false);
    }
  }
  return (
    <Card title="Sign in to administration" eyebrow="Course Core">
      <p>
        Sign in with your username and password
        {passkeys ? ", or with a passkey you have added" : ""}. Access is
        determined by your workspace membership.
      </p>
      <form
        className="stack"
        aria-label="Sign in with your username and password"
        onSubmit={(event) => {
          event.preventDefault();
          void attempt(async () => {
            if (mustChange) {
              const problem = newPasswordProblem(next, repeat, password);
              if (problem) {
                setError(problem);
                return;
              }
            }
            await postJson("/auth/login", {
              login: login.trim(),
              password,
              ...(mustChange ? { newPassword: next } : {}),
            });
            setPassword("");
            setNext("");
            setRepeat("");
            onSignedIn();
          });
        }}
      >
        <Field label="Username" htmlFor={id + "-login"}>
          <input
            id={id + "-login"}
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            maxLength={512}
            value={login}
            onChange={(event) => setLogin(event.target.value)}
            disabled={pending || mustChange}
          />
        </Field>
        <Field
          label={mustChange ? "Temporary password" : "Password"}
          htmlFor={id + "-password"}
        >
          <input
            id={id + "-password"}
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={pending || mustChange}
          />
        </Field>
        {mustChange && (
          <>
            <Notice tone="gold" title="Choose your own password">
              Your account has a temporary password. Choose a new one to
              continue.
            </Notice>
            <Field
              label="New password"
              htmlFor={id + "-new"}
              hint={`At least ${PASSWORD_MIN_LENGTH} characters. Spaces and any characters are allowed.`}
            >
              <input
                id={id + "-new"}
                name="new-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={PASSWORD_MIN_LENGTH}
                value={next}
                onChange={(event) => setNext(event.target.value)}
                disabled={pending}
              />
            </Field>
            <Field label="Repeat new password" htmlFor={id + "-repeat"}>
              <input
                id={id + "-repeat"}
                name="repeat-new-password"
                type="password"
                autoComplete="new-password"
                required
                value={repeat}
                onChange={(event) => setRepeat(event.target.value)}
                disabled={pending}
              />
            </Field>
          </>
        )}
        {error && <Notice tone="red">{error}</Notice>}
        <Button type="submit" kind="primary" disabled={pending}>
          {pending
            ? "Signing in…"
            : mustChange
              ? "Set password and sign in"
              : "Sign in"}
        </Button>
      </form>
      {passkeys && !mustChange && passkeysSupported() && (
        <PasskeySignInButton
          disabled={pending}
          onStart={() => setError("")}
          onSignedIn={onSignedIn}
          onError={setError}
        />
      )}
      {loginCodes && (
        <form
          className="stack sign-in-code"
          aria-label="Sign in with a one-time code"
          onSubmit={(event) => {
            event.preventDefault();
            void attempt(async () => {
              await postJson("/auth/redeem", { token: code });
              setCode("");
              onSignedIn();
            });
          }}
        >
          <Field label="One-time sign-in code" htmlFor={id + "-code"}>
            <input
              id={id + "-code"}
              type="password"
              autoComplete="one-time-code"
              required
              pattern="[A-Za-z0-9_\-]{43}"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              disabled={pending}
            />
          </Field>
          <Button type="submit" disabled={pending}>
            Use code
          </Button>
        </form>
      )}
    </Card>
  );
}

/** Requires the current password; the server signs out every other session. */
export function ChangePasswordCard({
  loginName,
  headers,
  onClose,
}: {
  loginName?: string | null;
  headers: () => HeadersInit;
  onClose: (changed: boolean) => void;
}) {
  const id = useId();
  const [current, setCurrent] = useState(""),
    [next, setNext] = useState(""),
    [repeat, setRepeat] = useState("");
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  return (
    <Card title="Change password" className="change-password">
      <form
        className="stack"
        aria-label="Change your password"
        onSubmit={(event) => {
          event.preventDefault();
          if (pending) return;
          const problem = newPasswordProblem(next, repeat, current);
          if (problem) {
            setError(problem);
            return;
          }
          setPending(true);
          setError("");
          postJson(
            "/auth/password",
            { currentPassword: current, newPassword: next },
            headers(),
          )
            .then(() => onClose(true))
            .catch((caught) =>
              setError(
                authErrorMessage(
                  caught instanceof AuthRequestError ? caught.code : undefined,
                ),
              ),
            )
            .finally(() => setPending(false));
        }}
      >
        {loginName && (
          <input
            type="text"
            name="username"
            autoComplete="username"
            value={loginName}
            readOnly
            hidden
          />
        )}
        <Field label="Current password" htmlFor={id + "-current"}>
          <input
            id={id + "-current"}
            type="password"
            autoComplete="current-password"
            required
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            disabled={pending}
          />
        </Field>
        <Field
          label="New password"
          htmlFor={id + "-new"}
          hint={`At least ${PASSWORD_MIN_LENGTH} characters. Changing it signs you out everywhere else.`}
        >
          <input
            id={id + "-new"}
            type="password"
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            value={next}
            onChange={(event) => setNext(event.target.value)}
            disabled={pending}
          />
        </Field>
        <Field label="Repeat new password" htmlFor={id + "-repeat"}>
          <input
            id={id + "-repeat"}
            type="password"
            autoComplete="new-password"
            required
            value={repeat}
            onChange={(event) => setRepeat(event.target.value)}
            disabled={pending}
          />
        </Field>
        {error && <Notice tone="red">{error}</Notice>}
        <div className="tag-row">
          <Button type="submit" kind="primary" disabled={pending}>
            {pending ? "Saving…" : "Change password"}
          </Button>
          <Button
            type="button"
            onClick={() => onClose(false)}
            disabled={pending}
          >
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
