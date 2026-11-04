import React from "react";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { CourseView } from "../src/views/CourseView";
import { useWorkspace } from "../src/hooks/useAdmin";
import { releaseSchema } from "../src/domain/contracts";
import { demo } from "./helpers";
import { createAdminTranslator } from "../src/i18n";
import { releaseCheckText } from "../src/domain/releaseChecks";
import { stripBidiControls } from "@course-core/i18n";

const warning = {
  code: "SANDBOXED_WEB_ACTIVITIES",
  passed: true,
  warning: true,
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

it("words coded release checks in English and Hebrew, and falls back for codes it does not know", async () => {
  const { releaseCheckText } = await import("../src/domain/releaseChecks");
  const en = createAdminTranslator("en"),
    he = createAdminTranslator("he");
  expect(
    releaseCheckText(en, {
      code: "RUNTIME_UNSUPPORTED",
      params: { reason: "PUBLISH_CAPABILITY_MISSING" },
    }),
  ).toEqual({
    label: "Runs on this server",
    detail:
      "This host cannot run every path the course needs (PUBLISH_CAPABILITY_MISSING). Install the missing capability, then check again.",
  });
  expect(releaseCheckText(he, { code: "SDK_DIGEST_MATCHES" }).label).toBe(
    "חבילת הקורס נבדקה",
  );
  // A demo or older check keeps its own text; an unknown code still has a title.
  expect(releaseCheckText(he, { label: "Demo", detail: "Text" })).toEqual({
    label: "Demo",
    detail: "Text",
  });
  expect(releaseCheckText(en, { code: "NEW_CHECK" })).toEqual({
    label: "Check NEW_CHECK",
    detail: "",
  });
});

it("words command outcomes from codes in both languages, keeps stored English, and survives unknown codes", async () => {
  const { serverMessageText, serverMessageSchema } =
    await import("../src/domain/serverMessages");
  const en = createAdminTranslator("en"),
    he = createAdminTranslator("he");
  expect(
    serverMessageText(en, {
      code: "RELEASE_ARCHIVED",
      params: { learners: 1 },
    }),
  ).toBe(
    "Release archived. 1 learner on it keeps their release, evidence and support.",
  );
  expect(
    serverMessageText(en, {
      code: "ITEM_DEFECTIVE",
      params: { assessmentId: "min-a", evidence: 2, learners: 1 },
    }),
  ).toBe(
    "Item min-a marked defective. 2 evidence records for 1 learner were invalidated with the reason.",
  );
  expect(serverMessageText(he, { code: "OFFER_REJECTED" })).toBe(
    "ההצעה נדחתה. לא נעשה שימוש במכסה.",
  );
  expect(serverMessageText(he, "Stored English receipt.")).toBe(
    "Stored English receipt.",
  );
  expect(serverMessageText(en, { code: "SOMETHING_NEW" })).toBe(
    "Done. (Result code SOMETHING_NEW.)",
  );
  // Codes are machine codes: prose in the code field is refused.
  expect(
    serverMessageSchema.safeParse({ code: "Release archived." }).success,
  ).toBe(false);
});

it("names the checkpoint that breaks an evidence rule, in English and Hebrew", () => {
  const check = {
    code: "GATE_RECOGNITION_ONLY",
    passed: false,
    params: { gate: "notice-gate" },
  };
  const en = releaseCheckText(createAdminTranslator("en"), check),
    he = releaseCheckText(createAdminTranslator("he"), check);
  expect(en.label).toBe("Checkpoint passed by choosing answers alone");
  expect(en.detail).toMatch(
    /^Checkpoint notice-gate offers only multiple-choice questions/,
  );
  expect(en.detail).toMatch(/cannot be published until then\.$/);
  expect(he.label).toBe("נקודת בקרה שעוברים רק בבחירת תשובות");
  expect(stripBidiControls(he.detail)).toContain("נקודת הבקרה notice-gate");
  for (const code of [
    "GATE_PARTIAL_OBJECTIVES",
    "GATE_TRANSFER_MISSING",
    "GATE_MISCONCEPTION_CHECK_MISSING",
    "GATE_EVIDENCE_UNREACHABLE",
  ]) {
    const text = releaseCheckText(createAdminTranslator("he"), {
      ...check,
      code,
    });
    expect(text.label, code).not.toMatch(/GATE_|Check /);
    expect(stripBidiControls(text.detail), code).toContain("notice-gate");
  }
});

it("shows a version whose checks are still running as being checked, holds review, and reads the course again", async () => {
  const client = demo();
  const { result } = renderHook(() => useWorkspace(client, "sorting"));
  await waitFor(() => expect(result.current.workspace).toBeDefined());
  const workspace = result.current.workspace!;
  const draft = workspace.releases.find((r) => r.state === "draft")!;
  const checking = releaseSchema.parse({
    ...draft,
    checks: [],
    checking: true,
  });
  let resyncs = 0;
  const actions = {
    ...result.current,
    resync: async () => {
      resyncs++;
    },
  };
  const view = (release: typeof checking) => (
    <CourseView
      data={{
        ...workspace,
        releases: workspace.releases.map((r) =>
          r.id === draft.id ? release : r,
        ),
      }}
      client={client}
      actions={actions}
    />
  );
  vi.useFakeTimers();
  try {
    const { rerender } = render(view(checking));
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(draft.version) }),
    );
    const item = screen.getByText("Checking this version").closest("li")!;
    expect(within(item).getByText("Checking")).toBeVisible();
    const submit = screen.getByRole("button", { name: "Submit for review" });
    expect(submit).toBeDisabled();
    expect(
      screen.getByText("Wait until this version's checks finish."),
    ).toBeVisible();
    expect(resyncs).toBe(0);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(resyncs).toBe(1);
    // Checks recorded: the usual list, review open, no more reads.
    rerender(view(releaseSchema.parse({ ...draft, checking: false })));
    expect(screen.queryByText("Checking this version")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Submit for review" }),
    ).toBeEnabled();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(resyncs).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

it("words the checking state in English and Hebrew", () => {
  const en = createAdminTranslator("en"),
    he = createAdminTranslator("he");
  for (const key of [
    "courseView.check.checking",
    "courseView.checking.label",
    "courseView.checking.detail",
    "courseView.checking.row",
    "courseView.checking.wait",
    "overviewView.stat.defectsChecking",
  ] as const) {
    expect(en.has(key)).toBe(true);
    expect(he.has(key)).toBe(true);
    expect(he.t(key)).not.toBe(en.t(key));
  }
});
