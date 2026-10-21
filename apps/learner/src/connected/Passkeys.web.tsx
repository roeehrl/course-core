import React, { useCallback, useEffect, useState } from "react";
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { CourseApiError } from "../client/apiClient";
import { TextField } from "./PasswordForms.web";
import { useT } from "../i18n";

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
export function passkeyErrorMessage(cause: unknown) {
  if (cause instanceof CourseApiError) return cause.message;
  const error = cause as { name?: string; code?: string } | undefined;
  if (error?.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" || error?.name === "InvalidStateError")
    return "This device already has a passkey for your account.";
  if (error?.name === "NotAllowedError" || error?.code === "ERROR_CEREMONY_ABORTED" || error?.name === "AbortError")
    return "The passkey request was cancelled or timed out.";
  return "Passkeys are unavailable in this browser. Use your password instead.";
}

/** A readable default label such as "Passkey on iPhone". */
export function defaultPasskeyName(userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent) {
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
  return platform ? `Passkey on ${platform}` : "Passkey";
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
            .catch((cause) => setError(passkeyErrorMessage(cause)))
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

const when = (value: string | null) => (value ? new Date(value).toLocaleString() : "never");

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
  const [passkeys, setPasskeys] = useState<Passkey[]>(),
    [available, setAvailable] = useState(true),
    [name, setName] = useState(defaultPasskeyName),
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
    load().catch((cause) => setError(passkeyErrorMessage(cause)));
  }, [load]);
  async function run(action: () => Promise<void>) {
    if (pending) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (cause) {
      if (cause instanceof CourseApiError && cause.code === "REAUTHENTICATION_REQUIRED") setNeedsPassword(true);
      setError(passkeyErrorMessage(cause));
    } finally {
      setPending(false);
    }
  }
  const supported = passkeysSupported();
  return (
    <section className="connected-form connected-reading-card connected-passkeys" aria-labelledby="connected-passkeys-title">
      <h2 id="connected-passkeys-title">Passkeys</h2>
      <p>
        A passkey lets you sign in with your device's screen lock or a security key instead of typing your password.
        Your password keeps working either way.
      </p>
      {passkeys === undefined && !error && <p role="status">Loading your passkeys…</p>}
      {passkeys && passkeys.length === 0 && <p>You have no passkeys yet.</p>}
      {passkeys && passkeys.length > 0 && (
        <ul className="connected-passkey-list" aria-label="Your passkeys">
          {passkeys.map((passkey) => (
            <li key={passkey.id}>
              <div>
                <strong>{passkey.name}</strong>
                <small>
                  Added {when(passkey.createdAt)} · last used {when(passkey.lastUsedAt)}
                  {passkey.backedUp ? " · synced" : ""}
                </small>
              </div>
              <button
                type="button"
                className="connected-secondary"
                disabled={pending}
                aria-label={`Remove passkey ${passkey.name}`}
                onClick={() =>
                  void run(async () => {
                    await request(`/auth/passkeys/${encodeURIComponent(passkey.id)}`, "DELETE");
                    setNotice(`Removed “${passkey.name}”.`);
                    await load();
                  })
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {!available || !supported ? (
        <>
          <p role="status">
            {!available
              ? "Passkeys are not available on this server's address."
              : "This browser cannot create passkeys here. Use your password."}
          </p>
          <div className="connected-form-actions">
            <button type="button" className="connected-secondary" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      ) : (
        <form
          className="connected-form"
          aria-label="Add a passkey"
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
              setNotice(`Added “${saved.passkey.name}”. You can now sign in with it or with your password.`);
              await load();
            });
          }}
        >
          {loginName && <input type="text" name="username" autoComplete="username" value={loginName} readOnly hidden />}
          <TextField
            label="Passkey name"
            type="text"
            autoComplete="off"
            value={name}
            onChange={setName}
            disabled={pending}
            hint="Helps you recognise it later, for example the device."
          />
          {needsPassword && hasPassword && (
            <TextField
              label="Current password"
              autoComplete="current-password"
              value={password}
              onChange={setPassword}
              disabled={pending}
              hint="Required because you signed in a while ago."
            />
          )}
          {needsPassword && !hasPassword && <p role="status">Sign out and sign in again, then add the passkey.</p>}
          <div className="connected-form-actions">
            <button
              type="submit"
              className="connected-primary"
              disabled={pending || !name.trim() || (needsPassword && (!hasPassword || !password))}
            >
              {pending ? "Waiting…" : "Add a passkey"}
            </button>
            <button type="button" className="connected-secondary" disabled={pending} onClick={onClose}>
              Close
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
