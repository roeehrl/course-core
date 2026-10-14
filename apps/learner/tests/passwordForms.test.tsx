import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CourseApiError } from "../src/client/apiClient";
import { ChangePassword, PasswordSignIn, newPasswordProblem } from "../src/connected/PasswordForms.web";
import { ConnectedHost } from "../src/ConnectedHost.web";

afterEach(() => vi.unstubAllGlobals());
type Request = <T>(url: string, method?: string, payload?: unknown) => Promise<T>;

describe("learner password sign-in", () => {
  it("labels fields with autocomplete tokens and shows the code field only when enabled", () => {
    const request = vi.fn() as unknown as Request;
    const { rerender } = render(<PasswordSignIn request={request} loginCodes={false} onSignedIn={async () => {}} />);
    expect(screen.getByLabelText("Username")).toHaveAttribute("autocomplete", "username");
    expect(screen.getByLabelText("Password")).toHaveAttribute("autocomplete", "current-password");
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    expect(screen.queryByLabelText("One-time sign-in code")).toBeNull();
    rerender(<PasswordSignIn request={request} loginCodes onSignedIn={async () => {}} />);
    expect(screen.getByLabelText("One-time sign-in code")).toHaveAttribute("autocomplete", "one-time-code");
  });

  it("shows the server's generic failure and replaces a temporary password", async () => {
    const calls: unknown[] = [];
    let step = 0;
    const request = vi.fn(async (_url: string, _method?: string, payload?: unknown) => {
      calls.push(payload);
      step++;
      if (step === 1) throw new CourseApiError("LOGIN_FAILED", 401);
      if (step === 2) throw new CourseApiError("PASSWORD_CHANGE_REQUIRED", 409);
      return { authenticated: true };
    }) as unknown as Request;
    const signedIn = vi.fn(async () => {});
    render(<PasswordSignIn request={request} loginCodes={false} onSignedIn={signedIn} />);
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "learner.one" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong password!" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The username or password is incorrect.");
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "temporary-pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    const next = await screen.findByLabelText("New password");
    expect(next).toHaveAttribute("autocomplete", "new-password");
    fireEvent.change(next, { target: { value: "a learner passphrase" } });
    fireEvent.change(screen.getByLabelText("Repeat new password"), { target: { value: "a learner passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Set password and sign in" }));
    await waitFor(() => expect(signedIn).toHaveBeenCalledOnce());
    expect(calls[2]).toEqual({ login: "learner.one", password: "temporary-pass", newPassword: "a learner passphrase" });
  });

  it("validates new passwords locally with the same length-only policy", () => {
    expect(newPasswordProblem("eleven char", "eleven char")).toMatch(/at least 12/);
    expect(newPasswordProblem("twelve chars", "twelve chars")).toBeUndefined();
    expect(newPasswordProblem("twelve chars", "twelve charz")).toMatch(/do not match/);
  });

  it("changes a password with the current one", async () => {
    const request = vi.fn(async () => ({ changed: true, otherSessionsRevoked: 1 })) as unknown as Request;
    const closed = vi.fn();
    render(<ChangePassword request={request} loginName="learner.one" onClose={closed} />);
    expect(screen.getByLabelText("Current password")).toHaveAttribute("autocomplete", "current-password");
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "old passphrase" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new passphrase!" } });
    fireEvent.change(screen.getByLabelText("Repeat new password"), { target: { value: "new passphrase!" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() => expect(closed).toHaveBeenCalledWith(true));
    expect(request).toHaveBeenCalledWith("/auth/password", "POST", { currentPassword: "old passphrase", newPassword: "new passphrase!" });
  });
});

describe("connected learner host when signed out", () => {
  it("asks for a username and password and hides codes when the server disables them", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        seen.push(input);
        if (input === "/auth/options")
          return new Response(JSON.stringify({ password: { minLength: 12, maxLength: 1024 }, loginCodes: false }), { headers: { "Content-Type": "application/json" } });
        return new Response(JSON.stringify({ error: "UNAUTHENTICATED" }), { status: 401, headers: { "Content-Type": "application/json" } });
      }),
    );
    render(<ConnectedHost />);
    expect(await screen.findByLabelText("Username")).toBeInTheDocument();
    expect(screen.queryByLabelText("One-time sign-in code")).toBeNull();
    expect(seen).toEqual(["/auth/session", "/auth/options"]);
  });
});
