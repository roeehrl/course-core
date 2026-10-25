import { useCallback, useEffect, useId, useState } from "react";
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { Button, Field, Notice } from "./components/ui";
import { AuthRequestError, authErrorMessage, postJson } from "./SignIn";
import {
  englishTranslator,
  useI18n,
  useT,
  type MessageKey,
  type Translate,
} from "./i18n";

export interface Passkey {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  backedUp: boolean;
}

/** WebAuthn needs a secure context and the browser API; the server separately says
 * whether its configured origin can host passkeys. */
export function passkeysSupported() {
  try {
    return (
      typeof window !== "undefined" &&
      window.isSecureContext !== false &&
      browserSupportsWebAuthn()
    );
  } catch {
    return false;
  }
}

const PASSKEY_CODES = new Set([
  "PASSKEY_FAILED",
  "PASSKEY_CHALLENGE_INVALID",
  "PASSKEY_REGISTRATION_FAILED",
  "PASSKEY_ALREADY_REGISTERED",
  "PASSKEY_LIMIT",
  "PASSKEY_NOT_FOUND",
  "PASSKEY_NAME_INVALID",
  "PASSKEYS_UNAVAILABLE",
  "PASSWORD_CHANGE_REQUIRED",
  "REAUTHENTICATION_REQUIRED",
]);
/** Browser-side failures: the person cancelled, the device has the passkey already,
 * or WebAuthn is unavailable here. */
export function passkeyErrorMessage(
  caught: unknown,
  t: Translate = englishTranslator().t,
) {
  if (caught instanceof AuthRequestError)
    return caught.code && PASSKEY_CODES.has(caught.code)
      ? t(`passkeys.error.${caught.code}` as MessageKey)
      : authErrorMessage(caught.code, t);
  const error = caught as { name?: string; code?: string } | undefined;
  if (
    error?.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" ||
    error?.name === "InvalidStateError"
  )
    return t("passkeys.error.deviceRegistered");
  if (
    error?.name === "NotAllowedError" ||
    error?.code === "ERROR_CEREMONY_ABORTED" ||
    error?.name === "AbortError"
  )
    return t("passkeys.error.cancelled");
  return t("passkeys.error.browserUnavailable");
}

/** A readable default label such as "Passkey on Mac". */
export function defaultPasskeyName(
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
  t: Translate = englishTranslator().t,
) {
  const platform = [
    ["iPhone", /iPhone/],
    ["iPad", /iPad/],
    ["Android", /Android/],
    ["Mac", /Macintosh|Mac OS X/],
    ["Windows", /Windows/],
    ["ChromeOS", /CrOS/],
    ["Linux", /Linux/],
  ].find(([, pattern]) => (pattern as RegExp).test(userAgent))?.[0] as
    string | undefined;
  return platform
    ? t("passkeys.defaultName.platform", { platform })
    : t("passkeys.defaultName");
}

async function requestJson(method: string, url: string, headers: HeadersInit) {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      credentials: "include",
      cache: "no-store",
      headers,
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

/** Signs in with a discoverable passkey: no username is asked for or revealed. */
export async function signInWithPasskey() {
  const { challengeId, options } = (await postJson(
    "/auth/passkeys/authentication/options",
    {},
  )) as {
    challengeId: string;
    options: PublicKeyCredentialRequestOptionsJSON;
  };
  const response = await startAuthentication({ optionsJSON: options });
  await postJson("/auth/passkeys/authentication/verify", {
    challengeId,
    response,
  });
}

export function PasskeySignInButton({
  disabled,
  onStart,
  onSignedIn,
  onError,
}: {
  disabled?: boolean;
  onStart: () => void;
  onSignedIn: () => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [pending, setPending] = useState(false);
  return (
    <div className="stack passkey-sign-in">
      <Button
        type="button"
        disabled={disabled || pending}
        onClick={() => {
          if (pending) return;
          setPending(true);
          onStart();
          signInWithPasskey()
            .then(onSignedIn)
            .catch((caught) => onError(passkeyErrorMessage(caught, t)))
            .finally(() => setPending(false));
        }}
      >
        {pending ? t("passkeys.signIn.waiting") : t("passkeys.signIn.button")}
      </Button>
    </div>
  );
}

/** Lists, adds and removes the signed-in person's passkeys. Passwords stay available,
 * so removing the last passkey is allowed. The body of the "Passkeys" dialog. */
export function PasskeysPanel({
  loginName,
  hasPassword,
  headers,
  onClose,
  onPendingChange,
}: {
  loginName?: string | null;
  hasPassword: boolean;
  headers: () => HeadersInit;
  onClose: () => void;
  /** While a passkey is being added or removed the dialog does not close. */
  onPendingChange?: (pending: boolean) => void;
}) {
  const id = useId();
  const i18n = useI18n();
  const t = i18n.t;
  const when = (value: string | null) =>
    value
      ? i18n.dateTime(value, { dateStyle: "medium", timeStyle: "short" })
      : t("passkeys.never");
  const [passkeys, setPasskeys] = useState<Passkey[]>(),
    [available, setAvailable] = useState(true),
    [name, setName] = useState(() => defaultPasskeyName(undefined, t)),
    [password, setPassword] = useState(""),
    [needsPassword, setNeedsPassword] = useState(false),
    [pending, setPendingState] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const setPending = (value: boolean) => {
    setPendingState(value);
    onPendingChange?.(value);
  };
  const load = useCallback(async () => {
    const data = (await requestJson("GET", "/auth/passkeys", {})) as {
      available: boolean;
      passkeys: Passkey[];
    };
    setAvailable(data.available);
    setPasskeys(data.passkeys);
  }, []);
  useEffect(() => {
    load().catch((caught) => setError(passkeyErrorMessage(caught, t)));
  }, [load]);
  async function run(action: () => Promise<void>) {
    if (pending) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (caught) {
      if (
        caught instanceof AuthRequestError &&
        caught.code === "REAUTHENTICATION_REQUIRED"
      )
        setNeedsPassword(true);
      setError(passkeyErrorMessage(caught, t));
    } finally {
      setPending(false);
    }
  }
  async function add() {
    const { challengeId, options } = (await postJson(
      "/auth/passkeys/registration/options",
      needsPassword ? { currentPassword: password } : {},
      headers(),
    )) as {
      challengeId: string;
      options: PublicKeyCredentialCreationOptionsJSON;
    };
    setPassword("");
    setNeedsPassword(false);
    const response = await startRegistration({ optionsJSON: options });
    const saved = (await postJson(
      "/auth/passkeys/registration/verify",
      { challengeId, name, response },
      headers(),
    )) as {
      passkey: Passkey;
    };
    setNotice(t("passkeys.added", { name: saved.passkey.name }));
    await load();
  }
  const supported = passkeysSupported();
  return (
    <div className="stack passkeys">
      <p>{t("passkeys.intro")}</p>
      {passkeys === undefined && !error && (
        <p role="status">{t("passkeys.loading")}</p>
      )}
      {passkeys && passkeys.length === 0 && <p>{t("passkeys.empty")}</p>}
      {passkeys && passkeys.length > 0 && (
        <ul className="passkey-list" aria-label={t("passkeys.listLabel")}>
          {passkeys.map((passkey) => (
            <li key={passkey.id}>
              <div>
                <strong dir="auto">{passkey.name}</strong>
                <small>
                  {t(
                    passkey.backedUp ? "passkeys.metaSynced" : "passkeys.meta",
                    {
                      added: when(passkey.createdAt),
                      lastUsed: when(passkey.lastUsedAt),
                    },
                  )}
                </small>
              </div>
              <Button
                kind="danger"
                disabled={pending}
                aria-label={t("passkeys.removeLabel", { name: passkey.name })}
                onClick={() =>
                  void run(async () => {
                    await requestJson(
                      "DELETE",
                      `/auth/passkeys/${encodeURIComponent(passkey.id)}`,
                      headers(),
                    );
                    setNotice(t("passkeys.removed", { name: passkey.name }));
                    await load();
                  })
                }
              >
                {t("passkeys.remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error && <Notice tone="red">{error}</Notice>}
      {notice && <Notice tone="green">{notice}</Notice>}
      {!available || !supported ? (
        <>
          <Notice tone="gold">
            {!available
              ? t("passkeys.unavailableServer")
              : t("passkeys.unavailableBrowser")}
          </Notice>
          <div className="dialog-actions dialog-footer">
            <Button type="button" onClick={onClose}>
              {t("passkeys.close")}
            </Button>
          </div>
        </>
      ) : (
        <form
          className="stack"
          aria-label={t("passkeys.addLabel")}
          onSubmit={(event) => {
            event.preventDefault();
            void run(add);
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
          <Field
            label={t("passkeys.name.label")}
            htmlFor={id + "-name"}
            hint={t("passkeys.name.hint")}
          >
            <input
              id={id + "-name"}
              required
              maxLength={100}
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={pending}
            />
          </Field>
          {needsPassword && hasPassword && (
            <Field
              label={t("passkeys.password.label")}
              htmlFor={id + "-password"}
              hint={t("passkeys.password.hint")}
            >
              <input
                id={id + "-password"}
                type="password"
                autoComplete="current-password"
                dir="ltr"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={pending}
              />
            </Field>
          )}
          {needsPassword && !hasPassword && (
            <Notice tone="gold">{t("passkeys.signInAgain")}</Notice>
          )}
          <div className="dialog-actions">
            <Button
              type="submit"
              kind="primary"
              disabled={pending || (needsPassword && !hasPassword)}
            >
              {pending ? t("passkeys.waiting") : t("passkeys.add")}
            </Button>
          </div>
        </form>
      )}
      {available && supported && (
        // The dialog's own action stays at its bottom edge, however long the list is.
        <div className="dialog-actions dialog-footer">
          <Button type="button" onClick={onClose} disabled={pending}>
            {t("passkeys.close")}
          </Button>
        </div>
      )}
    </div>
  );
}
