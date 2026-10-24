import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUPPORTED_LOCALES, stripBidiControls } from "@course-core/i18n";
import { SignInCard, authErrorMessage } from "../src/SignIn";
import { LocaleSwitcher } from "../src/components/LocaleSwitcher";
import { ConnectedHost } from "../src/ConnectedHost";
import { LOCALE_STORAGE_KEY, LocaleProvider } from "../src/i18n/LocaleProvider";
import { createAdminTranslator } from "../src/i18n";
import { catalogs } from "../src/i18n/catalog";
import { roleLabel } from "../src/AdminApp";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/admin/");
  document.documentElement.lang = "";
  document.documentElement.dir = "";
});
afterEach(() => vi.unstubAllGlobals());

describe("admin locale", () => {
  it("switches the sign-in screen to Hebrew, right to left, and remembers the choice", () => {
    render(
      <LocaleProvider>
        <LocaleSwitcher />
        <SignInCard loginCodes={false} onSignedIn={() => {}} />
      </LocaleProvider>,
    );
    expect(document.documentElement).toHaveAttribute("lang", "en");
    expect(document.documentElement).toHaveAttribute("dir", "ltr");
    expect(screen.getByText("Sign in to administration")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Language"), {
      target: { value: "he" },
    });
    expect(document.documentElement).toHaveAttribute("lang", "he");
    expect(document.documentElement).toHaveAttribute("dir", "rtl");
    expect(screen.getByText("כניסה לאזור הניהול")).toBeInTheDocument();
    expect(screen.getByLabelText("שם משתמש")).toHaveAttribute(
      "autocomplete",
      "username",
    );
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("he");
    // Every option names its language in that language.
    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(expect.arrayContaining(["English", "עברית"]));
  });

  it("starts from the browser language and accepts a ?locale= pseudo-locale override", () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["he-IL", "en"]);
    const { unmount } = render(
      <LocaleProvider>
        <SignInCard loginCodes={false} onSignedIn={() => {}} />
      </LocaleProvider>,
    );
    expect(document.documentElement).toHaveAttribute("dir", "rtl");
    unmount();
    window.history.replaceState(null, "", "/admin/?locale=en-XA");
    render(
      <LocaleProvider>
        <SignInCard loginCodes={false} onSignedIn={() => {}} />
      </LocaleProvider>,
    );
    expect(document.documentElement).toHaveAttribute("lang", "en-XA");
    expect(
      screen.getByText(/^⟦Šîĝñ îñ ţö åðɱîñîšţŕåţîöñ [~ ]+⟧$/),
    ).toBeVisible();
  });

  it("after sign-in, applies the saved preference and saves a choice made before sign-in", async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "he");
    document.cookie = "course_csrf=csrf-token";
    const saved: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/auth/session")
          return json({ user: { id: "u1", displayName: "Dana" } });
        if (url === "/api/me/locale" && init?.method === "PUT") {
          saved.push({
            body: JSON.parse(String(init.body)),
            csrf: (init.headers as Record<string, string>)["X-CSRF-Token"],
          });
          return json({ preference: "he", locale: "he", source: "user" });
        }
        if (url === "/api/me/locale")
          return json({ preference: null, locale: "en", source: "request" });
        if (url === "/api/workspaces") return json([]);
        return json({ error: "UNAVAILABLE" }, 503);
      }),
    );
    render(
      <LocaleProvider>
        <ConnectedHost />
      </LocaleProvider>,
    );
    await waitFor(() =>
      expect(saved).toEqual([{ body: { locale: "he" }, csrf: "csrf-token" }]),
    );
    expect(document.documentElement).toHaveAttribute("dir", "rtl");
    fireEvent.click(
      await screen.findByRole("button", { name: /^החשבון שלך: \W*Dana\W*$/ }),
    );
    expect(screen.getByRole("menuitem", { name: "יציאה" })).toBeVisible();
    expect(
      screen.getByRole("menuitemradio", { name: "עברית" }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("translates API error codes and server role codes, with English for unknown roles", () => {
    const he = createAdminTranslator("he");
    expect(authErrorMessage("LOGIN_FAILED", he.t)).toBe(
      "שם המשתמש או הסיסמה שגויים.",
    );
    expect(stripBidiControls(authErrorMessage("PASSWORD_POLICY", he.t))).toBe(
      "הסיסמה צריכה להכיל בין 12 ל-1,024 תווים.",
    );
    expect(authErrorMessage("SOMETHING_NEW", he.t)).toBe(
      "הכניסה אינה זמינה כרגע. כדאי לבדוק את החיבור ולנסות שוב.",
    );
    expect(roleLabel(he, "owner")).toBe("בעלים");
    expect(roleLabel(he, "future_role")).toBe("future_role");
  });

  it("reports a missing translation once in tests and falls back to English", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const he = createAdminTranslator("he");
    expect(he.t("missing.key" as never)).toBe("missing.key");
    expect(he.t("missing.key" as never)).toBe("missing.key");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("[i18n] unknown he missing.key");
  });

  it("every supported locale has a catalog", () => {
    expect(Object.keys(catalogs).sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });
});
