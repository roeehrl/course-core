import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { CourseVersionNotice } from "../src/components/CourseVersionNotice.web";
import { I18nProvider, createLearnerTranslator } from "../src/i18n";
import { connectedSnapshot } from "./connectedFixtures";

const notice = { id: "00000000-0000-4000-8000-0000000000aa", fromVersion: "1.0.0", toVersion: "2.0.0", movedAt: "2026-10-20T10:00:00.000Z" };

describe("your course was updated (course version moves)", () => {
  afterEach(() => window.localStorage.clear());

  it("tells a moved learner what changed and what is kept, until they dismiss it on this device", async () => {
    const server = { ...connectedSnapshot(), courseVersionNotice: notice };
    const { unmount } = render(<CourseVersionNotice server={server} />);
    const status = screen.getByRole("status", { name: "Your course was updated" });
    expect(status).toHaveTextContent(/moved from version 1\.0\.0 to version 2\.0\.0/);
    expect(status).toHaveTextContent(/stay in your learning record/);
    expect(status).toHaveTextContent(/may ask you to pass it again/);
    await userEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("status", { name: "Your course was updated" })).toBeNull();
    unmount();
    // Dismissed stays dismissed for this move; a later move shows again.
    const { unmount: second } = render(<CourseVersionNotice server={server} />);
    expect(screen.queryByRole("status")).toBeNull();
    second();
    render(<CourseVersionNotice server={{ ...server, courseVersionNotice: { ...notice, id: "00000000-0000-4000-8000-0000000000bb", fromVersion: "2.0.0", toVersion: "3.0.0" } }} />);
    expect(screen.getByRole("status")).toHaveTextContent(/version 2\.0\.0 to version 3\.0\.0/);
  });

  it("says it in Hebrew, and shows nothing without a recent move", () => {
    const { unmount } = render(<I18nProvider value={createLearnerTranslator("he")}><CourseVersionNotice server={{ ...connectedSnapshot(), courseVersionNotice: notice }} /></I18nProvider>);
    expect(screen.getByRole("status", { name: "הקורס שלך עודכן" })).toHaveTextContent(/הועבר מגרסה \u2068?1\.0\.0\u2069? לגרסה \u2068?2\.0\.0/);
    unmount();
    const { container } = render(<CourseVersionNotice server={{ ...connectedSnapshot(), courseVersionNotice: null }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
