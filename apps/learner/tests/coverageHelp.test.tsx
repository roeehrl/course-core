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
  it("keeps well-formed coverage and question allowance, and drops malformed ones without failing", () => {
    const ok = parseEnrollmentPolicy(
      { ...policyFixture(), coverage: coverage(2, 1), closedQuestions: { budget: 3, used: 1, remaining: 2 } },
      "enrollment-1",
    );
    expect(ok.coverage?.coveredCoreObjectives).toBe(2);
    expect(ok.closedQuestions).toEqual({ budget: 3, used: 1, remaining: 2 });
    const bad = parseEnrollmentPolicy(
      { ...policyFixture(), coverage: { ...coverage(9), denominator: 4 }, closedQuestions: { budget: -1 } },
      "enrollment-1",
    );
    expect(bad.coverage).toBeUndefined();
    expect(bad.closedQuestions).toBeUndefined();
    expect(parseEnrollmentPolicy(policyFixture(), "enrollment-1").coverage).toBeUndefined();
  });
  it("states core coverage against the fixed denominator and keeps extras apart from completion", () => {
    expect(coverageText(coverage(1)).core).toBe("1 of 4 core objectives covered");
    expect(coverageText(coverage(1)).extras).toBeUndefined();
    expect(coverageText(coverage(3, 2)).extras).toMatch(/^2 personal extras added for you — optional support that does not change/);
    const { course, snapshot } = presentation(connectedSnapshot());
    render(
      <CourseRoadmap course={course} snapshot={snapshot} compact coverage={coverage(3, 1)} onOpenLesson={vi.fn()} onPlacement={vi.fn()} />,
    );
    expect(screen.getByText("3 of 4 core objectives covered")).toBeVisible();
    expect(screen.getByText(/1 personal extra added for you/)).toBeVisible();
  });
  it("tells the learner how many closed-course questions remain, and when none do", () => {
    expect(closedHelpText({ budget: 3, used: 1, remaining: 2 }, false)).toBe(
      "This course is closed. You can still ask 2 more questions about its material (1 of 3 used). Questions never change your results.",
    );
    expect(closedHelpText({ budget: 1, used: 0, remaining: 1 }, false)).toContain("1 more question about");
    expect(closedHelpText({ remaining: 0 }, true)).toMatch(/every question it allows after closing has been used/);
  });
});
