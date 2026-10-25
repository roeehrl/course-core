import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { YourDataPanel } from "../src/components/YourDataPanel.web";
import { I18nProvider, createLearnerTranslator } from "../src/i18n";

const enrollmentId = "00000000-0000-4000-8000-000000000001";
describe("staff access to the learner's record", () => {
  it("lists each read-only staff view and staff download with who and when, oldest first", async () => {
    const api = {
      request: vi.fn(async () => ({
        views: [{ id: "v1", viewedAt: "2026-10-14T10:00:00.000Z", viewerName: "Course owner", viewerRole: "owner" }],
        exports: [
          { id: "x2", exportedAt: "2026-10-14T12:00:00.000Z", exporterName: "Course admin", exporterRole: "admin" },
          { id: "x1", exportedAt: "2026-10-14T09:00:00.000Z", exporterName: "Course owner", exporterRole: "owner" },
        ],
      })),
    };
    render(<YourDataPanel api={api as never} enrollmentId={enrollmentId} courseTitle="Ordering" onErased={vi.fn()} />);
    const list = await screen.findByRole("list");
    const items = within(list).getAllByRole("listitem").map((item) => item.textContent);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatch(/^Course owner \(owner\) downloaded a copy of your data/);
    expect(items[1]).toMatch(/^Course owner \(owner\) viewed your record/);
    expect(items[2]).toMatch(/^Course admin \(admin\) downloaded a copy of your data/);
    expect(api.request).toHaveBeenCalledWith(`/api/enrollments/${enrollmentId}/staff-views`);
    expect(screen.getByRole("heading", { name: "Staff access to your record" })).toBeVisible();
    // Honest about what each kind of access includes.
    expect(screen.getByText(/neither the view nor their copy includes your companion conversation or your own notes; only your own download does/)).toBeVisible();
    expect(screen.getByText(/Both include your profile: your display name, learning goal and pace/)).toBeVisible();
  });
  it("still lists views from a server that reports no downloads", async () => {
    const api = { request: vi.fn(async () => ({ views: [{ id: "v1", viewedAt: "2026-10-14T10:00:00.000Z", viewerName: "Course owner", viewerRole: "owner" }] })) };
    render(<YourDataPanel api={api as never} enrollmentId={enrollmentId} courseTitle="Ordering" onErased={vi.fn()} />);
    expect(await screen.findByText(/Course owner \(owner\) viewed your record/)).toBeVisible();
  });
  it("says when no one has viewed or downloaded it, and when the list is unavailable", async () => {
    const empty = { request: vi.fn(async () => ({ views: [], exports: [] })) };
    const { unmount } = render(<YourDataPanel api={empty as never} enrollmentId={enrollmentId} courseTitle="Ordering" onErased={vi.fn()} />);
    // While loading, "Checking…" sits over an invisible, aria-hidden copy of the
    // empty message that holds its space.
    expect(screen.getByText("Checking…")).toBeVisible();
    expect(screen.getByText("No one on the course staff has viewed or downloaded your record.")).toHaveAttribute("aria-hidden", "true");
    expect(await screen.findByText("No one on the course staff has viewed or downloaded your record.", { selector: "p" })).toBeVisible();
    expect(screen.queryByText("Checking…")).toBeNull();
    unmount();
    const failing = {
      request: vi.fn(async () => {
        throw new Error("offline");
      }),
    };
    render(<YourDataPanel api={failing as never} enrollmentId={enrollmentId} courseTitle="Ordering" onErased={vi.fn()} />);
    expect(await screen.findByText("This list could not be loaded right now.")).toBeVisible();
  });
});

describe("erasing the whole account", () => {
  const erasing = () => {
    const calls: { path: string; body: unknown }[] = [];
    const api = {
      request: vi.fn(async (path: string, _method?: string, body?: unknown) => {
        calls.push({ path, body });
        // Refused here, so the test page is not navigated away after a success.
        if (path === "/api/account/erase") throw new Error("not in this test");
        return { views: [], exports: [] };
      }),
    };
    return { api, calls };
  };
  for (const [locale, phrase, reason, button] of [
    ["he", "מחיקת החשבון שלי", "מה הסיבה למחיקת החשבון?", "מחיקת החשבון שלי לצמיתות"],
    ["en", "ERASE MY ACCOUNT", "Why are you erasing your account?", "Erase my account permanently"],
  ] as const)
    it(`${locale}: asks for the phrase in the screen's language and sends it with that language`, async () => {
      const { api, calls } = erasing();
      render(
        <I18nProvider value={createLearnerTranslator(locale)}>
          <YourDataPanel api={api as never} enrollmentId={enrollmentId} courseTitle="Ordering" onErased={vi.fn()} />
        </I18nProvider>,
      );
      const field = await screen.findByLabelText(new RegExp(phrase));
      // The label shows the phrase to type in this language (Hebrew no longer asks for English).
      expect(field.closest("div")!.querySelector(`label[for="${field.id}"] strong`)!.textContent!.replace(/[⁦-⁩]/g, "")).toBe(phrase);
      const erase = screen.getByRole("button", { name: button });
      fireEvent.change(screen.getByLabelText(new RegExp(reason.replace("?", "\\?"))), { target: { value: "Leaving every course on this service." } });
      fireEvent.change(field, { target: { value: "ERASE" } });
      expect(erase).toBeDisabled();
      // Pasted with the direction marks the label carries, it still counts.
      fireEvent.change(field, { target: { value: `⁨${phrase}⁩` } });
      expect(erase).toBeEnabled();
      fireEvent.click(erase);
      await waitFor(() => expect(calls.some((c) => c.path === "/api/account/erase")).toBe(true));
      expect(calls.find((c) => c.path === "/api/account/erase")!.body).toEqual({
        confirmation: phrase,
        locale,
        reason: "Leaving every course on this service.",
      });
    });
});

describe("erasing one course's learning data", () => {
  const shortId = enrollmentId.slice(0, 8);
  const erasing = () => {
    const calls: { path: string; body: unknown }[] = [];
    const api = {
      request: vi.fn(async (path: string, _method?: string, body?: unknown) => {
        calls.push({ path, body });
        if (path.endsWith("/erase")) return { enrollmentId, status: "erased", counts: {}, replayed: false };
        return { views: [], exports: [] };
      }),
    };
    return { api, calls };
  };
  for (const [locale, phrase, reason, button] of [
    ["he", `מחיקה ${shortId}`, "מה הסיבה למחיקה?", "מחיקה לצמיתות"],
    ["en", `ERASE ${shortId}`, "Why are you erasing it?", "Erase permanently"],
  ] as const)
    it(`${locale}: asks for the phrase in the screen's language, the id left to right, and sends that language`, async () => {
      const { api, calls } = erasing();
      const onErased = vi.fn();
      render(
        <I18nProvider value={createLearnerTranslator(locale)}>
          <YourDataPanel api={api as never} enrollmentId={enrollmentId} courseTitle="Ordering" onErased={onErased} />
        </I18nProvider>,
      );
      const field = await screen.findByLabelText((label) => label.replace(/[⁦-⁩]/g, "").includes(phrase));
      const strong = field.closest("div")!.querySelector(`label[for="${field.id}"] strong`)!;
      expect(strong.textContent!.replace(/[⁦-⁩]/g, "")).toBe(phrase);
      // The id is a left-to-right isolate inside a right-to-left phrase; the field follows what is typed.
      if (locale === "he") expect(strong.textContent).toContain(`⁦${shortId}⁩`);
      expect(field).toHaveAttribute("dir", "auto");
      const erase = screen.getByRole("button", { name: button });
      fireEvent.change(screen.getByLabelText(new RegExp(reason.replace("?", "\\?"))), { target: { value: "Leaving this course for good." } });
      // The other language's phrase, or another enrollment's id, is not what this screen asks for.
      fireEvent.change(field, { target: { value: locale === "he" ? `ERASE ${shortId}` : `מחיקה ${shortId}` } });
      expect(erase).toBeDisabled();
      fireEvent.change(field, { target: { value: phrase.replace(shortId, "ffffffff") } });
      expect(erase).toBeDisabled();
      // Pasted with the direction marks the label carries, it still counts.
      fireEvent.change(field, { target: { value: strong.textContent! } });
      expect(erase).toBeEnabled();
      fireEvent.click(erase);
      await waitFor(() => expect(onErased).toHaveBeenCalled());
      expect(calls.find((c) => c.path === `/api/enrollments/${enrollmentId}/erase`)!.body).toEqual({
        confirmation: phrase,
        locale,
        reason: "Leaving this course for good.",
      });
    });
});
