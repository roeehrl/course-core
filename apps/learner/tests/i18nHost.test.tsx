import React from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { stripBidiControls } from "@course-core/i18n";
import { CourseApiError, apiErrorMessage, setApiErrorTranslator, useApiErrorLocale } from "../src/client/apiClient";
import { ConnectionStatus, DraftConflict } from "../src/connected/connectivity.web";
import { passkeyErrorMessage, defaultPasskeyName } from "../src/connected/Passkeys.web";
import { policyDate, quotaLabel, quotaName, scopeLabel } from "../src/connected/policyPresentation";
import { mediaAvailability } from "../src/connected/resources";
import { validateProfile } from "../src/domain/profile";
import { courseContentAttributes } from "../src/domain/contentLanguage";
import { I18nProvider, createLearnerTranslator } from "../src/i18n";
import { connectedSnapshot } from "./connectedFixtures";

const he = createLearnerTranslator("he");
afterEach(() => setApiErrorTranslator(undefined));

describe("API error messages follow the UI locale", () => {
  it("explains known codes, falls back to the generic message, and reads the locale when shown", () => {
    const error = new CourseApiError("STALE_REVISION", 409);
    expect(error.message).toBe("Your progress changed on another request or device. Refresh before trying again.");
    expect(new CourseApiError("SOMETHING_NEW", 500).message).toBe(
      "The request could not be completed. Your saved progress has been preserved.",
    );
    setApiErrorTranslator(he.t);
    // The same error object now reads in Hebrew: a message shown after a language switch follows it.
    expect(error.message).toBe(he.t("apiClient.error.STALE_REVISION"));
    expect(error.message).toMatch(/[א-ת]/);
    expect(apiErrorMessage("NOT_A_CODE", he.t)).toBe(he.t("apiClient.error.generic"));
    expect(passkeyErrorMessage(new CourseApiError("PASSKEY_LIMIT", 409), he.t)).toBe(
      he.t("apiClient.error.PASSKEY_LIMIT"),
    );
  });
  it("useApiErrorLocale sets the translator while the host is mounted", () => {
    function Host() {
      useApiErrorLocale();
      return <p>{new CourseApiError("LOGIN_FAILED", 401).message}</p>;
    }
    const { unmount } = render(
      <I18nProvider value={he}>
        <Host />
      </I18nProvider>,
    );
    expect(screen.getByText("שם המשתמש או הסיסמה שגויים.")).toBeInTheDocument();
    unmount();
    expect(new CourseApiError("LOGIN_FAILED", 401).message).toBe("The username or password is incorrect.");
  });
});

describe("Hebrew connection and draft messages", () => {
  it("names the saved action in a whole Hebrew sentence", () => {
    render(
      <I18nProvider value={he}>
        <ConnectionStatus online={false} pendingAction="answers" pending={false} onRetry={() => undefined} />
      </I18nProvider>,
    );
    expect(stripBidiControls(screen.getByRole("status").textContent ?? "")).toContain(
      "עדיין לא נרשם: התשובה שלך שמורה במכשיר הזה ותישלח כשהחיבור יחזור.",
    );
  });
  it("labels both draft versions in Hebrew and isolates the draft text", () => {
    render(
      <I18nProvider value={he}>
        <DraftConflict
          label="התשובה שלך"
          shown={{ value: "mine", updatedAt: 0, deviceId: "a" }}
          other={{ value: "", updatedAt: 0, deviceId: "b" }}
          onKeepShown={() => undefined}
          onUseOther={() => undefined}
        />
      </I18nProvider>,
    );
    expect(screen.getByRole("button", { name: "שימוש בגרסה האחרת" })).toBeInTheDocument();
    expect(screen.getByText("(ריק)")).toHaveAttribute("dir", "auto");
    expect(screen.getByText("הגרסה שמוצגת כאן נשמרה קודם.")).toBeInTheDocument();
  });
});

describe("pure helpers take the translator", () => {
  it("formats policy dates, scopes and allowances for the locale", () => {
    const snapshot = connectedSnapshot();
    expect(policyDate(null, "UTC", he)).toBe("לא נקבע מועד אחרון בלוח השנה");
    expect(stripBidiControls(policyDate("2026-10-21T09:00:00Z", "UTC", he))).toMatch(/2026.* · UTC$/);
    expect(policyDate("2026-10-21T09:00:00Z", "UTC")).toMatch(/^Oct 21, 2026.* · UTC$/);
    expect(scopeLabel("course", snapshot.course, he.t)).toBe("קורס");
    expect(quotaName("additionalEpisodes", he.t)).toBe("שיעורים נוספים");
    expect(quotaLabel.additionalEpisodes).toBe("Extra lessons");
    expect(mediaAvailability(undefined, false, Date.now(), true, he.t).reason).toBe(
      "המדיה הזו חסרה. צוות הקורס צריך לשחזר אותה.",
    );
    expect(validateProfile({ displayName: "", goal: "", pace: "steady" }, he.t)).toBe("יש להזין שם באורך 1 עד 60 תווים.");
    expect(stripBidiControls(defaultPasskeyName("Mozilla/5.0 (Macintosh)", he.t))).toBe("מפתח גישה ב-Mac");
  });
  it("gives course content its own direction until the SDK declares a language", () => {
    expect(courseContentAttributes(connectedSnapshot().course)).toEqual({ dir: "auto" });
  });
});
