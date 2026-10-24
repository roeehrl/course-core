import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const webauthn = vi.hoisted(() => ({
  browserSupportsWebAuthn: vi.fn(() => true),
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
}));
vi.mock("@simplewebauthn/browser", () => webauthn);

import { SignInCard } from "../src/SignIn";
import {
  PasskeysPanel,
  defaultPasskeyName,
  passkeyErrorMessage,
} from "../src/Passkeys";
import { ConnectedHost } from "../src/ConnectedHost";
import { AuthRequestError } from "../src/SignIn";
import { createAdminTranslator } from "../src/i18n";
import { stripBidiControls } from "@course-core/i18n";

beforeEach(() => {
  webauthn.browserSupportsWebAuthn.mockReturnValue(true);
  webauthn.startAuthentication.mockReset();
  webauthn.startRegistration.mockReset();
});
afterEach(() => vi.unstubAllGlobals());
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

describe("passkey sign-in", () => {
  it("shows the button only when the server and the browser support passkeys", () => {
    const { rerender } = render(
      <SignInCard loginCodes={false} passkeys={false} onSignedIn={() => {}} />,
    );
    expect(
      screen.queryByRole("button", { name: "Sign in with passkey" }),
    ).toBeNull();
    rerender(<SignInCard loginCodes={false} passkeys onSignedIn={() => {}} />);
    expect(
      screen.getByRole("button", { name: "Sign in with passkey" }),
    ).toBeInTheDocument();
    // The password form is always there.
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    webauthn.browserSupportsWebAuthn.mockReturnValue(false);
    rerender(<SignInCard loginCodes={false} passkeys onSignedIn={() => {}} />);
    expect(
      screen.queryByRole("button", { name: "Sign in with passkey" }),
    ).toBeNull();
  });

  it("runs the discoverable-credential ceremony and signs in", async () => {
    const bodies: [string, unknown][] = [];
    stubFetch((url, init) => {
      bodies.push([url, JSON.parse(String(init?.body))]);
      return url.endsWith("/options")
        ? json({
            challengeId: "c-1",
            options: { challenge: "abc", rpId: "localhost" },
          })
        : json({ authenticated: true, csrfToken: "x".repeat(43) });
    });
    webauthn.startAuthentication.mockResolvedValue({
      id: "cred",
      response: {},
    });
    const signedIn = vi.fn();
    render(<SignInCard loginCodes={false} passkeys onSignedIn={signedIn} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Sign in with passkey" }),
    );
    await waitFor(() => expect(signedIn).toHaveBeenCalledOnce());
    expect(webauthn.startAuthentication).toHaveBeenCalledWith({
      optionsJSON: { challenge: "abc", rpId: "localhost" },
    });
    expect(bodies).toEqual([
      ["/auth/passkeys/authentication/options", {}],
      [
        "/auth/passkeys/authentication/verify",
        { challengeId: "c-1", response: { id: "cred", response: {} } },
      ],
    ]);
  });

  it("explains cancellation, refusal and the must-change state without signing in", async () => {
    stubFetch(() => json({ challengeId: "c-1", options: {} }));
    webauthn.startAuthentication.mockRejectedValue(
      Object.assign(new Error("cancelled"), { name: "NotAllowedError" }),
    );
    const signedIn = vi.fn();
    render(<SignInCard loginCodes={false} passkeys onSignedIn={signedIn} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Sign in with passkey" }),
    );
    expect(
      await screen.findByText(
        "The passkey request was cancelled or timed out.",
      ),
    ).toBeInTheDocument();
    expect(signedIn).not.toHaveBeenCalled();
    expect(passkeyErrorMessage(new AuthRequestError("PASSKEY_FAILED"))).toMatch(
      /not accepted/,
    );
    expect(
      passkeyErrorMessage(new AuthRequestError("PASSWORD_CHANGE_REQUIRED")),
    ).toMatch(/temporary password/);
    expect(
      passkeyErrorMessage(new AuthRequestError("LOGIN_THROTTLED")),
    ).toMatch(/Wait 15 minutes/);
  });

  it("names passkeys after the platform", () => {
    expect(
      defaultPasskeyName(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
      ),
    ).toBe("Passkey on iPhone");
    expect(
      defaultPasskeyName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"),
    ).toBe("Passkey on Mac");
    expect(defaultPasskeyName("Mozilla/5.0 (Linux; Android 15)")).toBe(
      "Passkey on Android",
    );
    expect(defaultPasskeyName("")).toBe("Passkey");
  });

  it("names passkeys and explains failures in Hebrew", () => {
    const { t } = createAdminTranslator("he");
    expect(
      stripBidiControls(
        defaultPasskeyName("Mozilla/5.0 (Linux; Android 15)", t),
      ),
    ).toBe("מפתח גישה ב-Android");
    expect(defaultPasskeyName("", t)).toBe("מפתח גישה");
    expect(
      passkeyErrorMessage(new AuthRequestError("PASSKEY_LIMIT"), t),
    ).toMatch(/^הגעת למספר המרבי של מפתחות גישה/);
    expect(passkeyErrorMessage({ name: "NotAllowedError" }, t)).toBe(
      "בקשת מפתח הגישה בוטלה או שפג הזמן שלה.",
    );
  });
});

describe("managing passkeys", () => {
  it("adds a passkey, asking for the password when the session is not fresh, and removes the last one", async () => {
    let passkeys = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Old key",
        createdAt: "2026-10-01T10:00:00Z",
        lastUsedAt: null,
        backedUp: false,
      },
    ];
    const requests: {
      url: string;
      method: string;
      body?: unknown;
      csrf: string | null;
    }[] = [];
    let reauthenticated = false;
    stubFetch((url, init) => {
      const method = init?.method ?? "GET",
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({
        url,
        method,
        body,
        csrf: new Headers(init?.headers).get("X-CSRF-Token"),
      });
      if (url === "/auth/passkeys" && method === "GET")
        return json({ available: true, passkeys });
      if (url === "/auth/passkeys/registration/options") {
        if (!body.currentPassword)
          return json({ error: "REAUTHENTICATION_REQUIRED" }, 403);
        reauthenticated = true;
        return json({ challengeId: "r-1", options: { challenge: "xyz" } });
      }
      if (url === "/auth/passkeys/registration/verify") {
        const passkey = {
          id: "22222222-2222-4222-8222-222222222222",
          name: body.name,
          createdAt: "2026-10-14T10:00:00Z",
          lastUsedAt: null,
          backedUp: true,
        };
        passkeys = [...passkeys, passkey];
        return json({ passkey });
      }
      if (method === "DELETE") {
        passkeys = passkeys.filter((p) => !url.endsWith(p.id));
        return json({ deleted: true });
      }
      return json({ error: "UNEXPECTED" }, 500);
    });
    webauthn.startRegistration.mockResolvedValue({ id: "new", response: {} });
    render(
      <PasskeysPanel
        loginName="member"
        hasPassword
        headers={() => ({ "X-CSRF-Token": "csrf-value" })}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText("Old key")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Passkey name"), {
      target: { value: "Desk key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add a passkey" }));
    const password = await screen.findByLabelText("Current password");
    expect(password).toHaveAttribute("autocomplete", "current-password");
    expect(webauthn.startRegistration).not.toHaveBeenCalled();
    fireEvent.change(password, { target: { value: "my passphrase here" } });
    fireEvent.click(screen.getByRole("button", { name: "Add a passkey" }));
    expect(await screen.findByText("Desk key")).toBeInTheDocument();
    expect(reauthenticated).toBe(true);
    expect(webauthn.startRegistration).toHaveBeenCalledWith({
      optionsJSON: { challenge: "xyz" },
    });
    expect(
      requests.find((r) => r.url.endsWith("/registration/verify")),
    ).toMatchObject({
      body: {
        challengeId: "r-1",
        name: "Desk key",
        response: { id: "new", response: {} },
      },
      csrf: "csrf-value",
    });
    for (const name of ["Old key", "Desk key"]) {
      fireEvent.click(
        screen.getByRole("button", { name: `Remove passkey ${name}` }),
      );
      await waitFor(() => expect(screen.queryByText(name)).toBeNull());
    }
    expect(
      await screen.findByText("You have no passkeys yet."),
    ).toBeInTheDocument();
    expect(
      requests
        .filter((r) => r.method === "DELETE")
        .every((r) => r.csrf === "csrf-value"),
    ).toBe(true);
  });

  it("says when the server's origin cannot host passkeys", async () => {
    stubFetch(() => json({ available: false, passkeys: [] }));
    render(
      <PasskeysPanel hasPassword headers={() => ({})} onClose={() => {}} />,
    );
    expect(
      await screen.findByText(
        "Passkeys are not available on this server's address.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add a passkey" })).toBeNull();
  });
});

describe("connected host", () => {
  it("offers passkey sign-in when the server advertises it, and Passkeys next to Change password in the account menu once signed in", async () => {
    let signedIn = false;
    stubFetch((url) => {
      if (url === "/auth/session")
        return signedIn
          ? json({
              user: {
                id: "u",
                displayName: "Member",
                loginName: "member",
                hasPassword: true,
              },
            })
          : json({ error: "UNAUTHENTICATED" }, 401);
      if (url === "/auth/options")
        return json({
          password: { minLength: 12, maxLength: 1024 },
          loginCodes: false,
          passkeys: true,
        });
      if (url === "/auth/passkeys/authentication/options")
        return json({ challengeId: "c", options: {} });
      if (url === "/auth/passkeys/authentication/verify") {
        signedIn = true;
        return json({ authenticated: true, csrfToken: "x".repeat(43) });
      }
      if (url === "/auth/passkeys")
        return json({ available: true, passkeys: [] });
      return json({});
    });
    webauthn.startAuthentication.mockResolvedValue({
      id: "cred",
      response: {},
    });
    render(<ConnectedHost />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Sign in with passkey" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Your account: Member" }),
    );
    expect(
      screen.getByRole("menuitem", { name: "Change password" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Passkeys" }));
    expect(screen.queryByRole("menu")).toBeNull();
    const dialog = screen.getByRole("dialog", { name: "Passkeys" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(
      await screen.findByText("You have no passkeys yet."),
    ).toBeInTheDocument();
  });
});
