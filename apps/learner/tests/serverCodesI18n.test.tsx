import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider, createLearnerTranslator } from "../src/i18n";
import { PersonalChanges } from "../src/components/PersonalChanges.web";
import { ChoiceList, Field } from "../src/components/ui";
import { connectedSnapshot } from "./connectedFixtures";

const change = (extra: Record<string, unknown>) => ({
  proposalId: "p1", appliedAt: "2026-10-21T09:00:00Z", episodeId: "min", episodeTitle: "Minimum", blockId: "b1",
  kind: "insert_episode", classification: "optional", hideable: false, hidden: false, planRevision: 1, ...extra,
});
const api = (changes: unknown[]) => ({ request: vi.fn(async () => ({ changes, planRevision: 1 })), command: vi.fn() });
const inLocale = (locale: "en" | "he", node: React.ReactElement) =>
  render(<I18nProvider value={createLearnerTranslator(locale)}>{node}</I18nProvider>);

describe("server reasons sent as codes", () => {
  it("translates Core's own personal-change reason into Hebrew, in the page direction", async () => {
    inLocale("he", <PersonalChanges api={api([change({ whyCode: "staff_remedial_episode", why: "" })]) as never} server={connectedSnapshot()} onChanged={() => {}} />);
    const reason = await screen.findByText("צוות הקורס הוסיף שיעור שכותבי הקורס כתבו ובדקו בדיוק למצב הזה.");
    expect(reason).not.toHaveAttribute("dir");
  });
  it("shows the English reason for the same code in English", async () => {
    inLocale("en", <PersonalChanges api={api([change({ whyCode: "fresh_question", why: "" })]) as never} server={connectedSnapshot()} onChanged={() => {}} />);
    expect(await screen.findByText(/You asked for a fresh question/)).toBeVisible();
  });
  it("keeps free text as written, isolated in its own direction, when there is no code", async () => {
    inLocale("he", <PersonalChanges api={api([change({ whyCode: null, why: "A reviewed note after a missed check." })]) as never} server={connectedSnapshot()} onChanged={() => {}} />);
    expect(await screen.findByText("A reviewed note after a missed check.")).toHaveAttribute("dir", "auto");
  });
  it("never shows a raw code a newer server sends that this app does not know", async () => {
    inLocale("he", <PersonalChanges api={api([change({ whyCode: "something_new", why: "" })]) as never} server={connectedSnapshot()} onChanged={() => {}} />);
    await screen.findByText(/Minimum/);
    expect(screen.queryByText("something_new")).toBeNull();
  });
});

describe("course text direction in shared controls", () => {
  it("keeps free-text fields in the interface's direction and gives course options their own on the web", () => {
    inLocale("he", <>
      <Field label="תשובה" value="" onChangeText={() => {}} />
      <Field label="מספר" dir="ltr" value="" onChangeText={() => {}} />
      <ChoiceList label="בחירה" value="" onChange={() => {}} options={[{ id: "a", label: "Keep the smaller value" }]} />
    </>);
    // An empty dir="auto" field is left to right: its Hebrew placeholder and caret sat on the left.
    // Typed text still shows in its own direction (unicode-bidi: plaintext).
    expect(screen.getByLabelText("תשובה")).toHaveAttribute("dir", "rtl");
    expect(screen.getByLabelText("תשובה")).toHaveStyle({ unicodeBidi: "plaintext" });
    expect(screen.getByLabelText("מספר")).toHaveAttribute("dir", "ltr");
    expect(screen.getByText("Keep the smaller value")).toHaveAttribute("dir", "auto");
  });
  it("moves to the next option with the left arrow in a right-to-left page", () => {
    const onChange = vi.fn();
    inLocale("he", <ChoiceList label="בחירה" value="a" onChange={onChange}
      options={[{ id: "a", label: "א" }, { id: "b", label: "ב" }]} />);
    fireEvent.keyDown(screen.getByRole("radio", { name: "א" }), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenCalledWith("b");
  });
});
