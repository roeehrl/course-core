import React from "react";
import {
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, it } from "vitest";
import { CourseView } from "../src/views/CourseView";
import { useWorkspace } from "../src/hooks/useAdmin";
import { releaseSchema } from "../src/domain/contracts";
import { demo } from "./helpers";
import { createAdminTranslator } from "../src/i18n";

const warning = {
  label: "Sandboxed web activities",
  passed: true,
  warning: true,
  detail:
    "A sandboxed web activity runtime is installed. Never put sensitive data in activity state or configuration.",
};

it("shows a standing activity-runtime warning as a warning, without blocking review", async () => {
  const client = demo();
  const { result } = renderHook(() => useWorkspace(client, "sorting"));
  await waitFor(() => expect(result.current.workspace).toBeDefined());
  const workspace = result.current.workspace!;
  const release = releaseSchema.parse({
    ...workspace.releases[0]!,
    checks: [...workspace.releases[0]!.checks, warning],
  });
  render(
    <CourseView
      data={{
        ...workspace,
        releases: [release, ...workspace.releases.slice(1)],
      }}
      client={client}
      actions={result.current}
    />,
  );
  const item = screen.getByText("Sandboxed web activities").closest("li")!;
  expect(within(item).getByText("Warning")).toBeVisible();
  expect(
    within(item).getByText(/Never put sensitive data in activity state/),
  ).toBeVisible();
  expect(within(item).queryByText("Recorded")).toBeNull();
});

it("words the release comparison summary in English and Hebrew", () => {
  const en = createAdminTranslator("en"),
    he = createAdminTranslator("he");
  const summary = (identical: boolean, count: number) => ({
    identical: identical ? "yes" : "no",
    count,
  });
  expect(en.t("releaseSafetyPanel.diff.summary", summary(true, 0))).toBe(
    "identical content",
  );
  expect(en.t("releaseSafetyPanel.diff.summary", summary(false, 1))).toBe(
    "1 change",
  );
  expect(en.t("releaseSafetyPanel.diff.summary", summary(false, 3))).toBe(
    "3 changes",
  );
  expect(he.t("releaseSafetyPanel.diff.summary", summary(false, 2))).toBe(
    "שני שינויים",
  );
  expect(he.t("releaseSafetyPanel.diff.summary", summary(true, 0))).toBe(
    "תוכן זהה",
  );
});
