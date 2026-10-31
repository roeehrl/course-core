import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const webauthn = vi.hoisted(() => ({
  browserSupportsWebAuthn: vi.fn(() => true),
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
}));
vi.mock("@simplewebauthn/browser", () => webauthn);

import { CourseApiError } from "../src/client/apiClient";
import { PasskeyManager, PasskeySignIn, defaultPasskeyName, passkeyErrorMessage } from "../src/connected/Passkeys.web";
import { pressWhenReady } from "./pressWhenReady";

type Request = <T>(url: string, method?: string, payload?: unknown) => Promise<T>;
beforeEach(() => {
  webauthn.browserSupportsWebAuthn.mockReturnValue(true);
  webauthn.startAuthentication.mockReset();
  webauthn.startRegistration.mockReset();
});

describe("learner passkey sign-in", () => {
  it("runs the discoverable-credential ceremony through the API client", async () => {
    const calls: [string, string | undefined, unknown][] = [];
    const request = vi.fn(async (url: string, method?: string, payload?: unknown) => {
      calls.push([url, method, payload]);
      return url.endsWith("/options") ? { challengeId: "c-1", options: { challenge: "abc" } } : { authenticated: true };
    }) as unknown as Request;
    webauthn.startAuthentication.mockResolvedValue({ id: "cred" });
    const signedIn = vi.fn(async () => {});
    render(<PasskeySignIn request={request} onSignedIn={signedIn} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in with passkey" }));
    await waitFor(() => expect(signedIn).toHaveBeenCalledOnce());
    expect(webauthn.startAuthentication).toHaveBeenCalledWith({ optionsJSON: { challenge: "abc" } });
    expect(calls).toEqual([
      ["/auth/passkeys/authentication/options", "POST", {}],
      ["/auth/passkeys/authentication/verify", "POST", { challengeId: "c-1", response: { id: "cred" } }],
    ]);
  });

  it("explains a refused passkey and a cancelled prompt", async () => {
    let refuse = true;
    const request = vi.fn(async (url: string) => {
      if (url.endsWith("/verify") && refuse) throw new CourseApiError("PASSKEY_FAILED", 401);
      return { challengeId: "c", options: {} };
    }) as unknown as Request;
    webauthn.startAuthentication.mockResolvedValue({ id: "cred" });
    const signedIn = vi.fn(async () => {});
    render(<PasskeySignIn request={request} onSignedIn={signedIn} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in with passkey" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That passkey was not accepted.");
    refuse = false;
    webauthn.startAuthentication.mockRejectedValue(Object.assign(new Error("x"), { name: "NotAllowedError" }));
    await pressWhenReady(screen.getByRole("button", { name: "Sign in with passkey" }));
    expect(await screen.findByText("The passkey request was cancelled or timed out.")).toBeInTheDocument();
    expect(signedIn).not.toHaveBeenCalled();
    expect(passkeyErrorMessage(new CourseApiError("PASSWORD_CHANGE_REQUIRED", 409))).toBe("Choose a new password to continue.");
    expect(defaultPasskeyName("Mozilla/5.0 (Linux; Android 15)")).toBe("Passkey on Android");
  });
});

describe("learner passkey management", () => {
  it("re-authenticates with the password when needed, adds, then removes every passkey", async () => {
    let passkeys: { id: string; name: string; createdAt: string; lastUsedAt: string | null; backedUp: boolean }[] = [];
    const calls: [string, string | undefined, unknown][] = [];
    const request = vi.fn(async (url: string, method = "GET", payload?: unknown) => {
      calls.push([url, method, payload]);
      if (url === "/auth/passkeys") return { available: true, passkeys };
      if (url.endsWith("/registration/options")) {
        if (!(payload as { currentPassword?: string }).currentPassword) throw new CourseApiError("REAUTHENTICATION_REQUIRED", 403);
        return { challengeId: "r", options: { challenge: "xyz" } };
      }
      if (url.endsWith("/registration/verify")) {
        const passkey = { id: "p-1", name: (payload as { name: string }).name, createdAt: "2026-10-14T10:00:00Z", lastUsedAt: null, backedUp: false };
        passkeys = [passkey];
        return { passkey };
      }
      if (method === "DELETE") {
        passkeys = [];
        return { deleted: true };
      }
      throw new Error(url);
    }) as unknown as Request;
    webauthn.startRegistration.mockResolvedValue({ id: "new" });
    render(<PasskeyManager request={request} loginName="learner" hasPassword />);
    expect(await screen.findByText("You have no passkeys yet.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Passkey name"), { target: { value: "My phone" } });
    await pressWhenReady(screen.getByRole("button", { name: "Add a passkey" }));
    const password = await screen.findByLabelText("Current password");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter your current password to add a passkey.");
    fireEvent.change(password, { target: { value: "my passphrase here" } });
    await pressWhenReady(screen.getByRole("button", { name: "Add a passkey" }));
    expect(await screen.findByText("My phone")).toBeInTheDocument();
    expect(calls).toContainEqual(["/auth/passkeys/registration/options", "POST", { currentPassword: "my passphrase here" }]);
    expect(calls).toContainEqual(["/auth/passkeys/registration/verify", "POST", { challengeId: "r", name: "My phone", response: { id: "new" } }]);
    await pressWhenReady(screen.getByRole("button", { name: "Remove passkey My phone" }));
    expect(await screen.findByText("You have no passkeys yet.")).toBeInTheDocument();
    expect(calls).toContainEqual(["/auth/passkeys/p-1", "DELETE", undefined]);
  });
});
