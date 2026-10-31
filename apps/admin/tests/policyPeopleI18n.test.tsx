import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { stripBidiControls } from "@course-core/i18n";
import { createAdminTranslator, I18nProvider } from "../src/i18n";
import {
  PeopleActionError,
  peopleErrorMessage,
  roleDescription,
  roleLabel,
} from "../src/domain/people";
import {
  PlacementAdminError,
  placementErrorMessage,
} from "../src/domain/placementAdmin";
import { ExtensionTerms } from "../src/components/ExtensionTerms";
import { ScopeQuotas } from "../src/components/PolicyDetails";
import type { LearningPolicy, ScopePolicy } from "../src/domain/policy";

const he = createAdminTranslator("he");
const en = createAdminTranslator("en");

describe("people and placement messages", () => {
  it("map server codes to the active locale and fall back for unknown codes", () => {
    expect(
      peopleErrorMessage(new PeopleActionError("LOGIN_NAME_TAKEN"), he.t),
    ).toBe("שם המשתמש הזה כבר תפוס. יש לבחור שם אחר.");
    expect(peopleErrorMessage(new PeopleActionError("NOPE"), he.t)).toBe(
      "ניהול האנשים לא זמין כרגע. לא בוצע שינוי בחברויות.",
    );
    expect(peopleErrorMessage(new Error("network"))).toBe(
      "The people service is unavailable. No membership was changed.",
    );
    // The allowed username symbols stay exact, isolated left to right in Hebrew.
    expect(
      peopleErrorMessage(new PeopleActionError("INVALID_INPUT"), en.t),
    ).toMatch(/letters, digits and \. _ @ \+ : -$/);
    expect(
      stripBidiControls(
        peopleErrorMessage(new PeopleActionError("INVALID_INPUT"), he.t),
      ),
    ).toMatch(/ספרות והתווים \. _ @ \+ : -$/);
    expect(
      placementErrorMessage(new PlacementAdminError("STALE_REVISION"), he.t),
    ).toBe("ההגדרות או ההרשמה השתנו מאז שנפתחו. יש לרענן ולנסות שוב.");
    expect(placementErrorMessage(new PlacementAdminError("OTHER"), he.t)).toBe(
      "ניהול השיבוץ לא זמין כרגע. דבר לא השתנה.",
    );
  });

  it("names roles by code in English and in words in Hebrew", () => {
    expect(roleLabel("course_scoped", en.t)).toBe("Course access only");
    expect(roleLabel("course_scoped", he.t)).toBe("גישה לפי קורס");
    expect(roleLabel("instructor", he.t)).toBe("מדריך/ה");
    expect(roleDescription("learner")).toBe("Studies enrolled courses only");
  });
});

describe("policy terms in Hebrew", () => {
  const scopes = [
    { scopeId: "chapter:1", label: "Chapter · Foundations" },
  ] as ScopePolicy[];
  const pools = [
    { poolId: "days", unit: "calendar_day" },
  ] as LearningPolicy["pools"];
  it("formats deadlines in UTC, pool units and plurals for the locale", () => {
    render(
      <I18nProvider value={he}>
        <ExtensionTerms
          terms={{
            currentEffectiveDeadline: "2026-11-01T09:00:00Z",
            proposedEffectiveDeadline: null as unknown as string,
            currentWorkQuotas: [],
            proposedWorkQuotas: [],
            balanceBefore: [
              { poolId: "days", remaining: 4, grantsRemaining: 2 },
            ],
            balanceAfter: [
              { poolId: "days", remaining: 2, grantsRemaining: 1 },
            ],
            poolDebits: [{ poolId: "days", amount: 2 }],
            bindingAncestorCaps: [],
            requiredApprovals: [],
          }}
          scopes={scopes}
          pools={pools}
        />
      </I18nProvider>,
    );
    expect(
      screen.getByRole("region", { name: "התנאים המדויקים לפני ואחרי" }),
    ).toBeInTheDocument();
    const text = stripBidiControls(document.body.textContent ?? "");
    expect(text).toMatch(/1 בנוב׳ 2026, 0?9:00 UTC/);
    expect(text).toContain("אין");
    expect(text).toContain("4 ימים קלנדריים / שתי הענקות");
    expect(text).toContain("2 ימים קלנדריים / הענקה אחת");
    expect(text).toContain(
      "אישורי סמכות נדרשים: אין, מלבד הסכמה מפורשת של הלומד/ת לתנאים המדויקים.",
    );
    // The pool id stays left to right inside the Hebrew sentence.
    const pool = document.querySelector("p > span.mono")!;
    expect(stripBidiControls(pool.textContent!)).toBe("days");
    expect(pool).toHaveAttribute("dir", "ltr");
  });

  it("keeps English work-cap tables unchanged", () => {
    render(
      <ScopeQuotas
        quotas={[
          {
            scopeId: "chapter:1",
            metric: "additionalMinutes",
            conceptId: null,
            limit: 120,
            consumed: 30,
            reserved: 0,
            remaining: 90,
          },
        ]}
        scopes={scopes}
      />,
    );
    expect(
      screen.getByRole("region", { name: "Work caps by scope" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Additional planned minutes")).toBeInTheDocument();
    expect(screen.getByText("Chapter · Foundations").tagName).toBe("BDI");
  });
});
