import React, { useCallback, useEffect, useState } from "react";
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { CourseApiError, apiErrorMessage } from "../client/apiClient";
import { TextField } from "./PasswordForms.web";
import { englishTranslator, useI18n, useT, type Translate } from "../i18n";

type Request = <T>(url: string, method?: string, payload?: unknown) => Promise<T>;
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
    return typeof window !== "undefined" && window.isSecureContext !== false && browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

/** Server codes use the shared API messages; browser failures are explained here. */
export function passkeyErrorMessage(cause: unknown, t: Translate = englishTranslator().t) {
  if (cause instanceof CourseApiError) return apiErrorMessage(cause.code, t);
  const error = cause as { name?: string; code?: string } | undefined;
  if (error?.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" || error?.name === "InvalidStateError")
    return t("passkeys.error.alreadyOnDevice");
  if (error?.name === "NotAllowedError" || error?.code === "ERROR_CEREMONY_ABORTED" || error?.name === "AbortError")
    return t("passkeys.error.cancelled");
  return t("passkeys.error.unsupported");
}

/** A readable default label such as "Passkey on iPhone". */
export function defaultPasskeyName(
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
  t: Translate = englishTranslator().t,
) {
  const platforms: [string, RegExp][] = [
    ["iPhone", /iPhone/],
    ["iPad", /iPad/],
    ["Android", /Android/],
    ["Mac", /Macintosh|Mac OS X/],
    ["Windows", /Windows/],
    ["ChromeOS", /CrOS/],
    ["Linux", /Linux/],
  ];
  const platform = platforms.find(([, pattern]) => pattern.test(userAgent))?.[0];
  return platform ? t("passkeys.defaultName.platform", { platform }) : t("passkeys.defaultName.generic");
}

/** Discoverable-credential sign-in: the device offers the account, so no username is
 * typed or revealed. Sessions and cookies are the same as for a password. */
export function PasskeySignIn({
  request,
  disabled,
  onSignedIn,
}: {
  request: Request;
  disabled?: boolean;
  onSignedIn: () => Promise<void>;
}) {
  const t = useT();
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="connected-form connected-passkey-sign-in">
      <button
        type="button"
        className="connected-secondary"
        disabled={disabled || pending}
        onClick={() => {
          if (pending) return;
          setPending(true);
          setError("");
          void (async () => {
            const { challengeId, options } = await request<{
              challengeId: string;
              options: PublicKeyCredentialRequestOptionsJSON;
            }>("/auth/passkeys/authentication/options", "POST", {});
            const response = await startAuthentication({ optionsJSON: options });
            await request("/auth/passkeys/authentication/verify", "POST", { challengeId, response });
            await onSignedIn();
          })()
            .catch((cause) => setError(passkeyErrorMessage(cause, t)))
            .finally(() => setPending(false));
        }}
      >
        {pending ? t("passkeys.signIn.waiting") : t("passkeys.signIn.button")}
      </button>
      {error && (
        <p className="connected-form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Lists, adds and removes the signed-in learner's passkeys. The password keeps
 * working, so removing the last passkey is allowed. */
export function PasskeyManager({
  request,
  loginName,
  hasPassword,
  onClose,
}: {
  request: Request;
  loginName?: string | null;
  hasPassword: boolean;
  onClose: () => void;
}) {
  const i18n = useI18n(),
    t = i18n.t;
  const when = (value: string | null) => (value ? i18n.dateTime(value) : t("passkeys.never"));
  const [passkeys, setPasskeys] = useState<Passkey[]>(),
    [available, setAvailable] = useState(true),
    [name, setName] = useState(() => defaultPasskeyName(undefined, t)),
    [password, setPassword] = useState(""),
    [needsPassword, setNeedsPassword] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    const data = await request<{ available: boolean; passkeys: Passkey[] }>("/auth/passkeys");
    setAvailable(data.available);
    setPasskeys(data.passkeys);
  }, [request]);
  useEffect(() => {
    load().catch((cause) => setError(passkeyErrorMessage(cause, t)));
  }, [load, t]);
  async function run(action: () => Promise<void>) {
    if (pending) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (cause) {
      if (cause instanceof CourseApiError && cause.code === "REAUTHENTICATION_REQUIRED") setNeedsPassword(true);
      setError(passkeyErrorMessage(cause, t));
    } finally {
      setPending(false);
    }
  }
  const supported = passkeysSupported();
  return (
    // The sheet it opens in (Overlay) shows the title and the close button.
    <section className="connected-form connected-reading-card connected-passkeys">
      <p>{t("passkeys.intro")}</p>
      {passkeys === undefined && !error && <p role="status">{t("passkeys.loading")}</p>}
      {passkeys && passkeys.length === 0 && <p>{t("passkeys.empty")}</p>}
      {passkeys && passkeys.length > 0 && (
        <ul className="connected-passkey-list" aria-label={t("passkeys.list")}>
          {passkeys.map((passkey) => (
            <li key={passkey.id}>
              <div>
                <strong dir="auto">{passkey.name}</strong>
                <small>
                  {t(passkey.backedUp ? "passkeys.usage.synced" : "passkeys.usage", {
                    added: when(passkey.createdAt),
                    lastUsed: when(passkey.lastUsedAt),
                  })}
                </small>
              </div>
              <button
                type="button"
                className="connected-secondary"
                disabled={pending}
                aria-label={t("passkeys.remove.label", { name: passkey.name })}
                onClick={() =>
                  void run(async () => {
                    await request(`/auth/passkeys/${encodeURIComponent(passkey.id)}`, "DELETE");
                    setNotice(t("passkeys.removed", { name: passkey.name }));
                    await load();
                  })
                }
              >
                {t("passkeys.remove")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {!available || !supported ? (
        <>
          <p role="status">
            {!available
              ? t("passkeys.unavailable.server")
              : t("passkeys.unavailable.browser")}
          </p>
          <div className="connected-form-actions">
            <button type="button" className="connected-secondary" onClick={onClose}>
              {t("passkeys.close")}
            </button>
          </div>
        </>
      ) : (
        <form
          className="connected-form"
          aria-label={t("passkeys.add")}
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const { challengeId, options } = await request<{
                challengeId: string;
                options: PublicKeyCredentialCreationOptionsJSON;
              }>("/auth/passkeys/registration/options", "POST", needsPassword ? { currentPassword: password } : {});
              setPassword("");
              setNeedsPassword(false);
              const response = await startRegistration({ optionsJSON: options });
              const saved = await request<{ passkey: Passkey }>("/auth/passkeys/registration/verify", "POST", {
                challengeId,
                name,
                response,
              });
              setNotice(t("passkeys.added", { name: saved.passkey.name }));
              await load();
            });
          }}
        >
          {loginName && <input type="text" name="username" autoComplete="username" value={loginName} readOnly hidden />}
          <TextField
            label={t("passkeys.name")}
            type="text"
            autoComplete="off"
            value={name}
            onChange={setName}
            disabled={pending}
            hint={t("passkeys.name.hint")}
          />
          {needsPassword && hasPassword && (
            <TextField
              label={t("passkeys.currentPassword")}
              autoComplete="current-password"
              value={password}
              onChange={setPassword}
              disabled={pending}
              hint={t("passkeys.currentPassword.hint")}
            />
          )}
          {needsPassword && !hasPassword && <p role="status">{t("passkeys.signInAgain")}</p>}
          <div className="connected-form-actions">
            <button
              type="submit"
              className="connected-primary"
              disabled={pending || !name.trim() || (needsPassword && (!hasPassword || !password))}
            >
              {pending ? t("passkeys.waiting") : t("passkeys.add")}
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="connected-form-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
