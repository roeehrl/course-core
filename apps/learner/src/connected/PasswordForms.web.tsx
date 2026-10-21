import React, { useId, useState } from "react";
import { CourseApiError } from "../client/apiClient";
import { englishTranslator, useT, type MessageKey, type Translate } from "../i18n";

type Request = <T>(url: string, method?: string, payload?: unknown) => Promise<T>;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 1024;
const length = (value: string) => Array.from(value.normalize("NFKC")).length;

/** Client-side mirror of the server policy; the server remains authoritative. */
export function newPasswordProblem(
  next: string,
  repeat: string,
  previous?: string,
  t: Translate = englishTranslator().t,
) {
  if (length(next) < PASSWORD_MIN_LENGTH) return t("passwordForms.problem.tooShort", { min: PASSWORD_MIN_LENGTH });
  if (length(next) > PASSWORD_MAX_LENGTH) return t("passwordForms.problem.tooLong", { max: PASSWORD_MAX_LENGTH });
  if (next !== repeat) return t("passwordForms.problem.mismatch");
  if (previous !== undefined && next.normalize("NFKC") === previous.normalize("NFKC"))
    return t("passwordForms.problem.unchanged");
  return undefined;
}
/** Sign-in and password API error codes this file explains. Other codes keep the API client's message. */
const AUTH_CODES = new Set([
  "LOGIN_FAILED",
  "LOGIN_THROTTLED",
  "AUTH_BUSY",
  "PASSWORD_POLICY",
  "PASSWORD_UNCHANGED",
  "CURRENT_PASSWORD_INCORRECT",
  "PASSWORD_NOT_SET",
  "LOGIN_CODE_INVALID",
  "LOGIN_CODES_DISABLED",
]);
export function authErrorMessage(cause: unknown, t: Translate = englishTranslator().t) {
  if (cause instanceof CourseApiError && AUTH_CODES.has(cause.code))
    return t(`passwordForms.error.${cause.code}` as MessageKey, { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH });
  return cause instanceof CourseApiError ? cause.message : t("passwordForms.error.unavailable");
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
        // Passwords and codes are left to right; a username may be in any script.
        dir={type === "password" ? "ltr" : "auto"}
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
  const t = useT();
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
      } else setError(authErrorMessage(cause, t));
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <form
        className="connected-form"
        aria-label={t("passwordForms.signInForm")}
        onSubmit={(event) => {
          event.preventDefault();
          void attempt(async () => {
            if (mustChange) {
              const problem = newPasswordProblem(next, repeat, password, t);
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
        <TextField label={t("passwordForms.username")} type="text" autoComplete="username" value={login} onChange={setLogin} disabled={pending || mustChange} />
        <TextField label={t(mustChange ? "passwordForms.temporaryPassword" : "passwordForms.password")} autoComplete="current-password" value={password} onChange={setPassword} disabled={pending || mustChange} />
        {mustChange && (
          <>
            <p role="status">{t("passwordForms.mustChange")}</p>
            <TextField
              label={t("passwordForms.newPassword")}
              autoComplete="new-password"
              value={next}
              onChange={setNext}
              disabled={pending}
              hint={t("passwordForms.newPasswordHint", { min: PASSWORD_MIN_LENGTH })}
            />
            <TextField label={t("passwordForms.repeatPassword")} autoComplete="new-password" value={repeat} onChange={setRepeat} disabled={pending} />
          </>
        )}
        {error && (
          <p className="connected-form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="connected-primary" disabled={pending || !login.trim() || !password}>
          {pending
            ? t("passwordForms.signingIn")
            : mustChange
              ? t("passwordForms.setPasswordAndSignIn")
              : t("passwordForms.signIn")}
        </button>
      </form>
      {loginCodes && (
        <form
          className="connected-form connected-code-form"
          aria-label={t("passwordForms.codeForm")}
          onSubmit={(event) => {
            event.preventDefault();
            void attempt(async () => {
              await request("/auth/redeem", "POST", { token: code.trim() });
              setCode("");
              await onSignedIn();
            });
          }}
        >
          <TextField label={t("passwordForms.code")} autoComplete="one-time-code" value={code} onChange={setCode} disabled={pending} />
          <button type="submit" className="connected-secondary" disabled={pending || !code.trim()}>
            {t("passwordForms.useCode")}
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
  const t = useT();
  const [current, setCurrent] = useState(""),
    [next, setNext] = useState(""),
    [repeat, setRepeat] = useState("");
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      className="connected-form connected-reading-card"
      aria-label={t("passwordForms.change.form")}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const problem = newPasswordProblem(next, repeat, current, t);
        if (problem) {
          setError(problem);
          return;
        }
        setPending(true);
        setError("");
        void request("/auth/password", "POST", { currentPassword: current, newPassword: next })
          .then(() => onClose(true))
          .catch((cause) => setError(authErrorMessage(cause, t)))
          .finally(() => setPending(false));
      }}
    >
      <h2>{t("passwordForms.change.title")}</h2>
      {/* Lets password managers associate the new password with this account. */}
      {loginName && (
        <input type="text" name="username" autoComplete="username" value={loginName} readOnly hidden />
      )}
      <TextField label={t("passwordForms.change.current")} autoComplete="current-password" value={current} onChange={setCurrent} disabled={pending} />
      <TextField
        label={t("passwordForms.newPassword")}
        autoComplete="new-password"
        value={next}
        onChange={setNext}
        disabled={pending}
        hint={t("passwordForms.change.hint", { min: PASSWORD_MIN_LENGTH })}
      />
      <TextField label={t("passwordForms.repeatPassword")} autoComplete="new-password" value={repeat} onChange={setRepeat} disabled={pending} />
      {error && (
        <p className="connected-form-error" role="alert">
          {error}
        </p>
      )}
      <div className="connected-form-actions">
        <button type="submit" className="connected-primary" disabled={pending || !current || !next}>
          {pending ? t("passwordForms.change.saving") : t("passwordForms.change.submit")}
        </button>
        <button type="button" className="connected-secondary" disabled={pending} onClick={() => onClose(false)}>
          {t("passwordForms.change.cancel")}
        </button>
      </div>
    </form>
  );
}
