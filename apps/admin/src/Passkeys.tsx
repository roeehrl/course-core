import { useCallback, useEffect, useId, useState } from "react";
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { Button, Card, Field, Notice } from "./components/ui";
import { AuthRequestError, authErrorMessage, postJson } from "./SignIn";

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

const passkeyMessages: Record<string, string> = {
  PASSKEY_FAILED:
    "That passkey was not accepted. Sign in with your password, or try another passkey.",
  PASSKEY_CHALLENGE_INVALID: "The passkey request expired. Try again.",
  PASSKEY_REGISTRATION_FAILED:
    "The passkey could not be verified. Try again, or use another device.",
  PASSKEY_ALREADY_REGISTERED: "This passkey is already registered.",
  PASSKEY_LIMIT:
    "You have the maximum number of passkeys. Remove one to add another.",
  PASSKEY_NOT_FOUND: "That passkey no longer exists.",
  PASSKEY_NAME_INVALID: "Use a name of 1 to 100 characters.",
  PASSKEYS_UNAVAILABLE: "Passkeys are not available on this server.",
  PASSWORD_CHANGE_REQUIRED:
    "Your account has a temporary password. Sign in with it and choose your own password first.",
  REAUTHENTICATION_REQUIRED: "Enter your current password to add a passkey.",
};
/** Browser-side failures: the person cancelled, the device has the passkey already,
 * or WebAuthn is unavailable here. */
export function passkeyErrorMessage(caught: unknown) {
  if (caught instanceof AuthRequestError)
    return (
      (caught.code && passkeyMessages[caught.code]) ||
      authErrorMessage(caught.code)
    );
  const error = caught as { name?: string; code?: string } | undefined;
  if (
    error?.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" ||
    error?.name === "InvalidStateError"
  )
    return "This device already has a passkey for your account.";
  if (
    error?.name === "NotAllowedError" ||
    error?.code === "ERROR_CEREMONY_ABORTED" ||
    error?.name === "AbortError"
  )
    return "The passkey request was cancelled or timed out.";
  return "Passkeys are unavailable in this browser. Use your password instead.";
}

/** A readable default label such as "Passkey on Mac". */
export function defaultPasskeyName(
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
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
  return platform ? `Passkey on ${platform}` : "Passkey";
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
            .catch((caught) => onError(passkeyErrorMessage(caught)))
            .finally(() => setPending(false));
        }}
      >
        {pending ? "Waiting for your passkey…" : "Sign in with passkey"}
      </Button>
    </div>
  );
}

const when = (value: string | null) =>
  value ? new Date(value).toLocaleString() : "never";

/** Lists, adds and removes the signed-in person's passkeys. Passwords stay available,
 * so removing the last passkey is allowed. */
export function PasskeysCard({
  loginName,
  hasPassword,
  headers,
  onClose,
}: {
  loginName?: string | null;
  hasPassword: boolean;
  headers: () => HeadersInit;
  onClose: () => void;
}) {
  const id = useId();
  const [passkeys, setPasskeys] = useState<Passkey[]>(),
    [available, setAvailable] = useState(true),
    [name, setName] = useState(defaultPasskeyName),
    [password, setPassword] = useState(""),
    [needsPassword, setNeedsPassword] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    const data = (await requestJson("GET", "/auth/passkeys", {})) as {
      available: boolean;
      passkeys: Passkey[];
    };
    setAvailable(data.available);
    setPasskeys(data.passkeys);
  }, []);
  useEffect(() => {
    load().catch((caught) => setError(passkeyErrorMessage(caught)));
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
      setError(passkeyErrorMessage(caught));
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
    setNotice(
      `Added “${saved.passkey.name}”. You can now sign in with it or with your password.`,
    );
    await load();
  }
  const supported = passkeysSupported();
  return (
    <Card title="Passkeys" className="passkeys">
      <p>
        A passkey lets you sign in with this device's screen lock or a security
        key instead of typing your password. Your password keeps working either
        way.
      </p>
      {passkeys === undefined && !error && (
        <p role="status">Loading your passkeys…</p>
      )}
      {passkeys && passkeys.length === 0 && <p>You have no passkeys yet.</p>}
      {passkeys && passkeys.length > 0 && (
        <ul className="passkey-list" aria-label="Your passkeys">
          {passkeys.map((passkey) => (
            <li key={passkey.id}>
              <div>
                <strong>{passkey.name}</strong>
                <small>
                  Added {when(passkey.createdAt)} · last used{" "}
                  {when(passkey.lastUsedAt)}
                  {passkey.backedUp ? " · synced" : ""}
                </small>
              </div>
              <Button
                kind="danger"
                disabled={pending}
                aria-label={`Remove passkey ${passkey.name}`}
                onClick={() =>
                  void run(async () => {
                    await requestJson(
                      "DELETE",
                      `/auth/passkeys/${encodeURIComponent(passkey.id)}`,
                      headers(),
                    );
                    setNotice(`Removed “${passkey.name}”.`);
                    await load();
                  })
                }
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {!available || !supported ? (
        <>
          <Notice tone="gold">
            {!available
              ? "Passkeys are not available on this server's address."
              : "This browser cannot create passkeys here. Use your password."}
          </Notice>
          <div className="tag-row">
            <Button type="button" onClick={onClose}>
              Close
            </Button>
          </div>
        </>
      ) : (
        <form
          className="stack"
          aria-label="Add a passkey"
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
            label="Passkey name"
            htmlFor={id + "-name"}
            hint="Helps you recognise it later, for example the device."
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
              label="Current password"
              htmlFor={id + "-password"}
              hint="Required because you signed in a while ago."
            >
              <input
                id={id + "-password"}
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={pending}
              />
            </Field>
          )}
          {needsPassword && !hasPassword && (
            <Notice tone="gold">
              Sign out and sign in again, then add the passkey.
            </Notice>
          )}
          <div className="tag-row">
            <Button
              type="submit"
              kind="primary"
              disabled={pending || (needsPassword && !hasPassword)}
            >
              {pending ? "Waiting…" : "Add a passkey"}
            </Button>
            <Button type="button" onClick={onClose} disabled={pending}>
              Close
            </Button>
          </div>
        </form>
      )}
      {error && <Notice tone="red">{error}</Notice>}
      {notice && <Notice tone="green">{notice}</Notice>}
    </Card>
  );
}
