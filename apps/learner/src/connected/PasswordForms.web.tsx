import React, { useId, useState } from "react";
import { CourseApiError } from "../client/apiClient";

type Request = <T>(url: string, method?: string, payload?: unknown) => Promise<T>;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 1024;
const length = (value: string) => Array.from(value.normalize("NFKC")).length;

/** Client-side mirror of the server policy; the server remains authoritative. */
export function newPasswordProblem(next: string, repeat: string, previous?: string) {
  if (length(next) < PASSWORD_MIN_LENGTH)
    return `Use at least ${PASSWORD_MIN_LENGTH} characters. A few unrelated words make a strong, memorable password.`;
  if (length(next) > PASSWORD_MAX_LENGTH)
    return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  if (next !== repeat) return "The new passwords do not match.";
  if (previous !== undefined && next.normalize("NFKC") === previous.normalize("NFKC"))
    return "Choose a password different from the current one.";
  return undefined;
}
function message(cause: unknown) {
  return cause instanceof CourseApiError
    ? cause.message
    : "Sign-in is unavailable. Check your connection and try again.";
}

export function TextField({
  label,
  value,
  onChange,
  type = "password",
  autoComplete,
  disabled,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "password";
  autoComplete: string;
  disabled?: boolean;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="connected-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        name={autoComplete}
        type={type}
        autoComplete={autoComplete}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        required
        value={value}
        disabled={disabled}
        aria-describedby={hint ? id + "-hint" : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint && <small id={id + "-hint"}>{hint}</small>}
    </div>
  );
}

/** Username/password sign-in. A temporary password set by an administrator must be
 * replaced before a session is issued. One-time codes appear only when the server
 * enables them. */
export function PasswordSignIn({
  request,
  loginCodes,
  onSignedIn,
}: {
  request: Request;
  loginCodes: boolean;
  onSignedIn: () => Promise<void>;
}) {
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
    } catch (cause) {
      if (cause instanceof CourseApiError && cause.code === "PASSWORD_CHANGE_REQUIRED") {
        setMustChange(true);
        setError("");
      } else setError(message(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <form
        className="connected-form"
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
            await request("/auth/login", "POST", {
              login: login.trim(),
              password,
              ...(mustChange ? { newPassword: next } : {}),
            });
            setPassword("");
            setNext("");
            setRepeat("");
            await onSignedIn();
          });
        }}
      >
        <TextField label="Username" type="text" autoComplete="username" value={login} onChange={setLogin} disabled={pending || mustChange} />
        <TextField label={mustChange ? "Temporary password" : "Password"} autoComplete="current-password" value={password} onChange={setPassword} disabled={pending || mustChange} />
        {mustChange && (
          <>
            <p role="status">
              Your administrator set a temporary password. Choose your own
              password to continue.
            </p>
            <TextField
              label="New password"
              autoComplete="new-password"
              value={next}
              onChange={setNext}
              disabled={pending}
              hint={`At least ${PASSWORD_MIN_LENGTH} characters. Spaces and any characters are allowed.`}
            />
            <TextField label="Repeat new password" autoComplete="new-password" value={repeat} onChange={setRepeat} disabled={pending} />
          </>
        )}
        {error && (
          <p className="connected-form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="connected-primary" disabled={pending || !login.trim() || !password}>
          {pending ? "Signing in…" : mustChange ? "Set password and sign in" : "Sign in"}
        </button>
      </form>
      {loginCodes && (
        <form
          className="connected-form connected-code-form"
          aria-label="Sign in with a one-time code"
          onSubmit={(event) => {
            event.preventDefault();
            void attempt(async () => {
              await request("/auth/redeem", "POST", { token: code.trim() });
              setCode("");
              await onSignedIn();
            });
          }}
        >
          <TextField label="One-time sign-in code" autoComplete="one-time-code" value={code} onChange={setCode} disabled={pending} />
          <button type="submit" className="connected-secondary" disabled={pending || !code.trim()}>
            Use code
          </button>
        </form>
      )}
    </>
  );
}

/** Changing a password requires the current one and signs out every other session. */
export function ChangePassword({
  request,
  loginName,
  onClose,
}: {
  request: Request;
  loginName?: string | null;
  onClose: (changed: boolean) => void;
}) {
  const [current, setCurrent] = useState(""),
    [next, setNext] = useState(""),
    [repeat, setRepeat] = useState("");
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      className="connected-form connected-reading-card"
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
        void request("/auth/password", "POST", { currentPassword: current, newPassword: next })
          .then(() => onClose(true))
          .catch((cause) => setError(message(cause)))
          .finally(() => setPending(false));
      }}
    >
      <h2>Change password</h2>
      {/* Lets password managers associate the new password with this account. */}
      {loginName && (
        <input type="text" name="username" autoComplete="username" value={loginName} readOnly hidden />
      )}
      <TextField label="Current password" autoComplete="current-password" value={current} onChange={setCurrent} disabled={pending} />
      <TextField
        label="New password"
        autoComplete="new-password"
        value={next}
        onChange={setNext}
        disabled={pending}
        hint={`At least ${PASSWORD_MIN_LENGTH} characters. Changing it signs you out on your other devices.`}
      />
      <TextField label="Repeat new password" autoComplete="new-password" value={repeat} onChange={setRepeat} disabled={pending} />
      {error && (
        <p className="connected-form-error" role="alert">
          {error}
        </p>
      )}
      <div className="connected-form-actions">
        <button type="submit" className="connected-primary" disabled={pending || !current || !next}>
          {pending ? "Saving…" : "Change password"}
        </button>
        <button type="button" className="connected-secondary" disabled={pending} onClick={() => onClose(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
