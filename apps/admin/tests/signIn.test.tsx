import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChangePasswordForm,
  SignInCard,
  authErrorMessage,
  newPasswordProblem,
} from "../src/SignIn";
import { ConnectedHost } from "../src/ConnectedHost";

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

describe("password sign-in", () => {
  it("labels fields with the right autocomplete tokens and hides codes unless enabled", () => {
    const { rerender } = render(
      <SignInCard loginCodes={false} onSignedIn={() => {}} />,
    );
    expect(screen.getByLabelText("Username")).toHaveAttribute(
      "autocomplete",
      "username",
    );
    expect(screen.getByLabelText("Password")).toHaveAttribute(
      "autocomplete",
      "current-password",
    );
    expect(screen.getByLabelText("Password")).toHaveAttribute(
      "type",
      "password",
    );
    expect(screen.queryByLabelText("One-time sign-in code")).toBeNull();
    rerender(<SignInCard loginCodes onSignedIn={() => {}} />);
    expect(screen.getByLabelText("One-time sign-in code")).toBeInTheDocument();
  });

  it("shows one generic message for failed sign-in and throttling", async () => {
    stubFetch(() => json({ error: "LOGIN_FAILED" }, 401));
    const signedIn = vi.fn();
    render(<SignInCard loginCodes={false} onSignedIn={signedIn} />);
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "someone" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "a wrong password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(
      await screen.findByText("The username or password is incorrect."),
    ).toBeInTheDocument();
    expect(signedIn).not.toHaveBeenCalled();
    expect(authErrorMessage("LOGIN_THROTTLED")).toContain("Wait 15 minutes");
  });

  it("replaces a temporary password before signing in", async () => {
    const bodies: unknown[] = [];
    stubFetch((url, init) => {
      expect(url).toBe("/auth/login");
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return body.newPassword
        ? json({ authenticated: true, csrfToken: "x".repeat(43) })
        : json({ error: "PASSWORD_CHANGE_REQUIRED" }, 409);
    });
    const signedIn = vi.fn();
    render(<SignInCard loginCodes={false} onSignedIn={signedIn} />);
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: " Member " },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "temporary-pass-word" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    const next = await screen.findByLabelText("New password");
    expect(next).toHaveAttribute("autocomplete", "new-password");
    expect(screen.getByLabelText("Repeat new password")).toHaveAttribute(
      "autocomplete",
      "new-password",
    );
    expect(screen.getByLabelText("Temporary password")).toBeDisabled();
    fireEvent.change(next, { target: { value: "my own passphrase" } });
    fireEvent.change(screen.getByLabelText("Repeat new password"), {
      target: { value: "my own passphrasf" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Set password and sign in" }),
    );
    expect(
      await screen.findByText("The new passwords do not match."),
    ).toBeInTheDocument();
    expect(bodies).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Repeat new password"), {
      target: { value: "my own passphrase" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Set password and sign in" }),
    );
    await waitFor(() => expect(signedIn).toHaveBeenCalledOnce());
    expect(bodies[1]).toEqual({
      login: "Member",
      password: "temporary-pass-word",
      newPassword: "my own passphrase",
    });
  });

  it("mirrors the length-only policy after NFKC", () => {
    expect(newPasswordProblem("short", "short")).toMatch(/at least 12/);
    expect(
      newPasswordProblem("long enough pw", "long enough pw"),
    ).toBeUndefined();
    expect(
      newPasswordProblem("long enough pw", "long enough pw", "long enough pw"),
    ).toMatch(/different/);
    expect(newPasswordProblem("x".repeat(1025), "x".repeat(1025))).toMatch(
      /at most 1,024/,
    );
    expect(
      newPasswordProblem("😀".repeat(12), "😀".repeat(12)),
    ).toBeUndefined();
  });
});

describe("changing a password", () => {
  it("sends the current password with the CSRF header and reports wrong current passwords", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    stubFetch((url, init) => {
      requests.push({ url, init });
      return requests.length === 1
        ? json({ error: "CURRENT_PASSWORD_INCORRECT" }, 403)
        : json({ changed: true, otherSessionsRevoked: 2 });
    });
    const closed = vi.fn();
    render(
      <ChangePasswordForm
        loginName="member"
        headers={() => ({ "X-CSRF-Token": "csrf-value" })}
        onClose={closed}
      />,
    );
    expect(screen.getByLabelText("Current password")).toHaveAttribute(
      "autocomplete",
      "current-password",
    );
    fireEvent.change(screen.getByLabelText("Current password"), {
      target: { value: "old passphrase" },
    });
    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "new passphrase!" },
    });
    fireEvent.change(screen.getByLabelText("Repeat new password"), {
      target: { value: "new passphrase!" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(
      await screen.findByText("Your current password is incorrect."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() => expect(closed).toHaveBeenCalledWith(true));
    expect(requests[1]!.url).toBe("/auth/password");
    expect(new Headers(requests[1]!.init?.headers).get("X-CSRF-Token")).toBe(
      "csrf-value",
    );
    expect(JSON.parse(String(requests[1]!.init?.body))).toEqual({
      currentPassword: "old passphrase",
      newPassword: "new passphrase!",
    });
  });
});

describe("connected host", () => {
  it("offers password sign-in when signed out and asks the server whether codes are enabled", async () => {
    const fetcher = stubFetch((url) =>
      url === "/auth/session"
        ? json({ error: "UNAUTHENTICATED" }, 401)
        : json({
            password: { minLength: 12, maxLength: 1024 },
            loginCodes: false,
          }),
    );
    render(<ConnectedHost />);
    expect(
      await screen.findByRole("heading", { name: "Sign in to administration" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Username")).toBeInTheDocument();
    expect(screen.queryByLabelText("One-time sign-in code")).toBeNull();
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "/auth/session",
      "/auth/options",
    ]);
  });
});
