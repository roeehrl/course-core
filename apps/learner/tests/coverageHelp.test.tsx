import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { parseEnrollmentPolicy } from "../src/client/policyClient";
import { CourseRoadmap, coverageText } from "../src/components/CourseRoadmap";
import { closedHelpText } from "../src/connected/companion/CompanionRegion.web";
import { closedHelpText as hostClosedHelpText } from "../src/ConnectedHost.web";
import { createLearnerTranslator } from "../src/i18n";
import { presentation } from "../src/client/presentation";
import { policyFixture } from "./policyFixtures";
import { connectedSnapshot } from "./connectedFixtures";

const coverage = (covered: number, extras = 0) => ({
  denominator: 4,
  coveredCoreObjectives: covered,
  personalExtras: {
    committed: { count: extras, additionalMinutes: 10 * extras, additionalEpisodes: extras },
    reserved: { count: 0, additionalMinutes: 0, additionalEpisodes: 0 },
  },
  headroom: [],
});

describe("coverage and closed-course questions", () => {
  it("tells the learner how many closed-course questions remain, and when none do", () => {
    // The host keeps re-exporting the region's text.
    expect(hostClosedHelpText).toBe(closedHelpText);
    expect(closedHelpText({ budget: 3, used: 1, remaining: 2 }, false)).toBe("Course closed · 2 questions left");
    expect(closedHelpText({ budget: 1, used: 0, remaining: 1 }, false)).toBe("Course closed · 1 question left");
    expect(closedHelpText({ remaining: 0 }, true)).toBe(
      "You've used every question this closed course allows. Your conversation and the course stay here to read.",
    );
    const { t } = createLearnerTranslator("he");
    expect(closedHelpText({ remaining: 3 }, false, t)).toBe("הקורס נסגר · נשארו 3 שאלות");
    expect(closedHelpText({ remaining: 1 }, false, t)).toBe("הקורס נסגר · נשארה שאלה אחת");
    expect(closedHelpText({ remaining: 0 }, true, t)).toBe("כל השאלות שהקורס הסגור מאפשר נוצלו. השיחה והקורס נשארים כאן לקריאה.");
  });
});
