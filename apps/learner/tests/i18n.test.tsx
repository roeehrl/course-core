import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUPPORTED_LOCALES } from "@course-core/i18n";
import { CourseApiError } from "../src/client/apiClient";
import { PasswordSignIn, authErrorMessage } from "../src/connected/PasswordForms.web";
import { LocaleSwitcher } from "../src/components/LocaleSwitcher.web";
import { LOCALE_STORAGE_KEY, LocaleProvider } from "../src/i18n/LocaleProvider";
import { createLearnerTranslator } from "../src/i18n";
import { catalogs } from "../src/i18n/catalog";

type Request = <T>(url: string, method?: string, payload?: unknown) => Promise<T>;
beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  document.documentElement.lang = "";
  document.documentElement.dir = "";
});
afterEach(() => vi.unstubAllGlobals());

describe("learner locale", () => {
  it("switches sign-in to Hebrew, sets html lang/dir and remembers the choice", () => {
    render(
      <LocaleProvider>
        <LocaleSwitcher />
        <PasswordSignIn request={vi.fn() as unknown as Request} loginCodes onSignedIn={async () => {}} />
      </LocaleProvider>,
    );
    expect(document.documentElement).toHaveAttribute("dir", "ltr");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "he" } });
    expect(document.documentElement).toHaveAttribute("lang", "he");
    expect(document.documentElement).toHaveAttribute("dir", "rtl");
    expect(screen.getByRole("button", { name: "כניסה" })).toBeInTheDocument();
    expect(screen.getByLabelText("קוד כניסה חד-פעמי")).toHaveAttribute("autocomplete", "one-time-code");
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("he");
  });

  it("shows ar-XB, the right-to-left pseudo-locale, from a ?locale= override", () => {
    window.history.replaceState(null, "", "/?locale=ar-XB");
    render(
      <LocaleProvider>
        <PasswordSignIn request={vi.fn() as unknown as Request} loginCodes={false} onSignedIn={async () => {}} />
      </LocaleProvider>,
    );
    expect(document.documentElement).toHaveAttribute("dir", "rtl");
    expect(screen.getByRole("button").textContent).toMatch(/^⟦‮Šîĝñ îñ‬ ~+⟧$/);
  });

  it("translates sign-in error codes; other API errors keep the client's message", () => {
    const he = createLearnerTranslator("he");
    expect(authErrorMessage(new CourseApiError("LOGIN_FAILED", 401), he.t)).toBe("שם המשתמש או הסיסמה שגויים.");
    expect(authErrorMessage(new Error("offline"), he.t)).toBe("הכניסה אינה זמינה כרגע. כדאי לבדוק את החיבור ולנסות שוב.");
    expect(authErrorMessage(new CourseApiError("STALE_REVISION", 409), he.t)).toMatch(/Refresh before trying again/);
  });

  it("every supported locale has a catalog", () => {
    expect(Object.keys(catalogs).sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });
});
