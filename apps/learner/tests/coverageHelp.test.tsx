import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { parseEnrollmentPolicy } from "../src/client/policyClient";
import { CourseRoadmap, coverageText } from "../src/components/CourseRoadmap";
import { closedHelpText } from "../src/ConnectedHost.web";
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
    expect(closedHelpText({ budget: 3, used: 1, remaining: 2 }, false)).toBe(
      "This course is closed. You can still ask 2 more questions about its material (1 of 3 used). Questions never change your results.",
    );
    expect(closedHelpText({ budget: 1, used: 0, remaining: 1 }, false)).toContain("1 more question about");
    expect(closedHelpText({ remaining: 0 }, true)).toMatch(/every question it allows after closing has been used/);
  });
});
