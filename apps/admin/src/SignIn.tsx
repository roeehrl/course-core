import { useId, useState } from "react";
import { Button, Card, Field, Notice } from "./components/ui";
import { PasskeySignInButton, passkeysSupported } from "./Passkeys";
import {
  englishTranslator,
  useT,
  type MessageKey,
  type Translate,
} from "./i18n";

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 1024;
const length = (value: string) => Array.from(value.normalize("NFKC")).length;

/** Client-side mirror of the server policy (length only); the server is authoritative. */
export function newPasswordProblem(
  next: string,
  repeat: string,
  previous?: string,
  t: Translate = englishTranslator().t,
) {
  if (length(next) < PASSWORD_MIN_LENGTH)
    return t("signIn.problem.tooShort", { min: PASSWORD_MIN_LENGTH });
  if (length(next) > PASSWORD_MAX_LENGTH)
    return t("signIn.problem.tooLong", { max: PASSWORD_MAX_LENGTH });
  if (next !== repeat) return t("signIn.problem.mismatch");
  if (
    previous !== undefined &&
    next.normalize("NFKC") === previous.normalize("NFKC")
  )
    return t("signIn.problem.unchanged");
  return undefined;
}
/** API error codes the sign-in and password forms explain; others get `signIn.error.unavailable`. */
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
  "ORIGIN_REJECTED",
  "CSRF_REJECTED",
  "UNAUTHENTICATED",
]);
export function authErrorMessage(
  code: string | undefined,
  t: Translate = englishTranslator().t,
) {
  return code && AUTH_CODES.has(code)
    ? t(`signIn.error.${code}` as MessageKey, {
        min: PASSWORD_MIN_LENGTH,
        max: PASSWORD_MAX_LENGTH,
      })
    : t("signIn.error.unavailable");
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
  const t = useT();
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
      else setError(authErrorMessage(code, t));
    } finally {
      setPending(false);
    }
  }
  return (
    <Card title={t("signIn.title")} eyebrow={t("signIn.eyebrow")}>
      <p>{t(passkeys ? "signIn.introPasskeys" : "signIn.intro")}</p>
      <form
        className="stack"
        aria-label={t("signIn.passwordForm")}
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
        <Field label={t("signIn.username")} htmlFor={id + "-login"}>
          <input
            id={id + "-login"}
            name="username"
            autoComplete="username"
            dir="auto"
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
          label={t(mustChange ? "signIn.temporaryPassword" : "signIn.password")}
          htmlFor={id + "-password"}
        >
          <input
            id={id + "-password"}
            name="password"
            type="password"
            dir="ltr"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={pending || mustChange}
          />
        </Field>
        {mustChange && (
          <>
            <Notice tone="gold" title={t("signIn.mustChange.title")}>
              {t("signIn.mustChange.body")}
            </Notice>
            <Field
              label={t("signIn.newPassword")}
              htmlFor={id + "-new"}
              hint={t("signIn.newPasswordHint", { min: PASSWORD_MIN_LENGTH })}
            >
              <input
                id={id + "-new"}
                name="new-password"
                type="password"
                dir="ltr"
                autoComplete="new-password"
                required
                minLength={PASSWORD_MIN_LENGTH}
                value={next}
                onChange={(event) => setNext(event.target.value)}
                disabled={pending}
              />
            </Field>
            <Field label={t("signIn.repeatPassword")} htmlFor={id + "-repeat"}>
              <input
                id={id + "-repeat"}
                name="repeat-new-password"
                type="password"
                dir="ltr"
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
            ? t("signIn.signingIn")
            : mustChange
              ? t("signIn.setPasswordAndSignIn")
              : t("signIn.submit")}
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
          aria-label={t("signIn.codeForm")}
          onSubmit={(event) => {
            event.preventDefault();
            void attempt(async () => {
              await postJson("/auth/redeem", { token: code });
              setCode("");
              onSignedIn();
            });
          }}
        >
          <Field label={t("signIn.code")} htmlFor={id + "-code"}>
            <input
              id={id + "-code"}
              type="password"
              dir="ltr"
              autoComplete="one-time-code"
              required
              pattern="[A-Za-z0-9_\-]{43}"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              disabled={pending}
            />
          </Field>
          <Button type="submit" disabled={pending}>
            {t("signIn.useCode")}
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
  const t = useT();
  const id = useId();
  const [current, setCurrent] = useState(""),
    [next, setNext] = useState(""),
    [repeat, setRepeat] = useState("");
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  return (
    <Card title={t("signIn.change.title")} className="change-password">
      <form
        className="stack"
        aria-label={t("signIn.change.form")}
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
                  t,
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
        <Field label={t("signIn.change.current")} htmlFor={id + "-current"}>
          <input
            id={id + "-current"}
            type="password"
            dir="ltr"
            autoComplete="current-password"
            required
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            disabled={pending}
          />
        </Field>
        <Field
          label={t("signIn.newPassword")}
          htmlFor={id + "-new"}
          hint={t("signIn.change.hint", { min: PASSWORD_MIN_LENGTH })}
        >
          <input
            id={id + "-new"}
            type="password"
            dir="ltr"
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            value={next}
            onChange={(event) => setNext(event.target.value)}
            disabled={pending}
          />
        </Field>
        <Field label={t("signIn.repeatPassword")} htmlFor={id + "-repeat"}>
          <input
            id={id + "-repeat"}
            type="password"
            dir="ltr"
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
            {pending ? t("signIn.change.saving") : t("signIn.change.submit")}
          </Button>
          <Button
            type="button"
            onClick={() => onClose(false)}
            disabled={pending}
          >
            {t("signIn.change.cancel")}
          </Button>
        </div>
      </form>
    </Card>
  );
}
