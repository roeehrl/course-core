import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ConnectedLesson,
  returnPoint,
  type ConnectedLessonProps,
} from "../src/connected/ConnectedLesson.web";
import { stripBidiControls } from "@course-core/i18n";
import { I18nProvider, createLearnerTranslator } from "../src/i18n";
import { connectedSnapshot } from "./connectedFixtures";
function props(): ConnectedLessonProps {
  const server = connectedSnapshot();
  return {
    server,
    episode: server.course.chapters[0]!.episodes[0]!,
    placement: false,
    pending: false,
    now: Date.now(),
    answer: "",
    onAnswerChange: vi.fn(),
    onRead: vi.fn(),
    onStart: vi.fn(),
    onAnswer: vi.fn(),
    onSolution: vi.fn(),
    onComplete: vi.fn(),
    onNormal: vi.fn(),
    onRefresh: vi.fn(),
    onBlockChange: vi.fn(),
  };
}
describe("linear connected lesson and authoritative gates", () => {
  it('offers an approved fresh check after item exhaustion without changing the completion gate',()=>{
    const p=props();p.server.lessons[0]!.completedBlockIds=p.episode.blocks.filter(b=>b.type!=='assessment').map(b=>b.id);p.server.activeChallenges=[];
    p.server.recovery=[{episodeId:p.episode.id,required:true,freshCheck:{objectiveId:p.episode.objectiveIds[0]!,familyId:'canonical',plannedMinutes:2,additionalEpisodes:1}}];
    render(<ConnectedLesson {...p}/>);fireEvent.click(screen.getByRole('button',{name:'Get a fresh check · 2 min →'}));expect(p.onStart).toHaveBeenCalledOnce();expect(screen.getByRole('button',{name:'Finish this lesson →'})).toBeDisabled();
  });
  it("shows only the current unread part and advances only after a server snapshot", () => {
    const p = props();
    const { container, rerender } = render(<ConnectedLesson {...p} />);
    expect(
      screen.getByRole("article", { name: "Reading part 1" }),
    ).toBeVisible();
    expect(container.querySelector("svg")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Finish this lesson →" }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Mark this part read" }),
    );
    expect(p.onRead).toHaveBeenCalledWith("reading");
    expect(
      screen.getByRole("article", { name: "Reading part 1" }),
    ).toBeVisible();
    p.server.lessons[0]!.completedBlockIds = ["reading"];
    rerender(<ConnectedLesson {...p} />);
    expect(
      screen.getByRole("article", { name: "Reading part 2" }),
    ).toBeVisible();
    expect(container.querySelector("svg")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Finish this lesson →" }),
    ).toBeDisabled();
  });
  it("blocks unreviewed mandatory media even when stale server coverage calls it read", () => {
    const p = props();
    p.server.lessons[0]!.completedBlockIds = ["reading", "picture", "movie"];
    p.server.lessons[0]!.gate!.passed = true;
    p.server.course.media[0]!.review = "unreviewed";
    render(<ConnectedLesson {...p} />);
    expect(
      screen.getByRole("button", { name: "Finish this lesson →" }),
    ).toBeDisabled();
    expect(
      screen.getByText(/required media step is unavailable/),
    ).toBeVisible();
    expect(p.onComplete).not.toHaveBeenCalled();
  });
  it("uses current server questions and preserves expired answer drafts without submitting", () => {
    const p = props();
    p.server.lessons[0]!.completedBlockIds = ["reading", "picture", "movie"];
    p.server.activeChallenges = [
      {
        challengeId: "fresh",
        episodeId: "intro",
        independentEligible: true,
        mode: "independent",
        question: {
          id: "q",
          type: "numeric",
          prompt: "A dynamically issued problem",
        },
        expiresAt: new Date(p.now - 1).toISOString(),
      },
    ];
    p.answer = "42";
    render(<ConnectedLesson {...p} />);
    expect(screen.getByRole("button", { name: "Refresh check" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Check answer" }),
    ).not.toBeInTheDocument();
    expect(p.onAnswer).not.toHaveBeenCalled();
    expect(p.onAnswerChange).not.toHaveBeenCalled();
  });
});

describe("return point after a detour (P12)", () => {
  /** The fixture with an optional lesson beside the current one, part 1 of the current lesson read. */
  function detour() {
    const p = props();
    const chapter = p.server.course.chapters[0]!;
    chapter.episodes.push({ id: "aside", title: "A closer look", objectiveIds: [], requirement: "optional", blocks: [{ id: "aside-text", type: "text", markdown: "More detail." }] });
    p.server.lessons.push({ id: "aside", status: "available", completedBlockIds: [], gate: null });
    p.server.lessons[0]!.completedBlockIds = ["reading"];
    p.episode = chapter.episodes[1]!;
    p.onReturn = vi.fn();
    return p;
  }
  it("names the lesson and part the learner returns to, and takes them there", () => {
    const p = detour();
    expect(returnPoint(p.server, p.episode, false)).toEqual({ kind: "optional", episodeId: "intro", title: "Notice the change", where: "part", part: 2, total: 3 });
    render(<ConnectedLesson {...p} />);
    expect(screen.getByTestId("detour-return")).toHaveTextContent("Optional detour: this lesson is not required. When you are done, you return to “Notice the change”, part 2 of 3.");
    fireEvent.click(screen.getByRole("button", { name: "Return to “Notice the change”" }));
    expect(p.onReturn).toHaveBeenCalledWith("intro");
  });
  it("names the check when every part is read, and a revisit of a finished lesson", () => {
    const p = detour();
    p.server.lessons[0]!.completedBlockIds = ["reading", "picture", "movie"];
    expect(returnPoint(p.server, p.episode, false)).toMatchObject({ where: "check" });
    p.episode = { ...p.episode, requirement: "required" };
    p.server.lessons[1]!.status = "completed";
    render(<ConnectedLesson {...p} />);
    expect(screen.getByTestId("detour-return")).toHaveTextContent("You are revisiting a lesson you finished. When you are done, you return to “Notice the change”, its check.");
  });
  it("shows nothing on the learner's own path or during placement", () => {
    const p = props();
    expect(returnPoint(p.server, p.episode, false)).toBeNull();
    const d = detour();
    expect(returnPoint(d.server, d.episode, true)).toBeNull();
    d.server.nextEpisodeId = null;
    expect(returnPoint(d.server, d.episode, false)).toBeNull();
    render(<ConnectedLesson {...p} />);
    expect(screen.queryByTestId("detour-return")).toBeNull();
  });
  it("says it in Hebrew", () => {
    const p = detour();
    render(<I18nProvider value={createLearnerTranslator("he")}><ConnectedLesson {...p} /></I18nProvider>);
    expect(stripBidiControls(screen.getByTestId("detour-return").textContent ?? "")).toContain("מעקף רשות: השיעור הזה לא חובה. בסיום חוזרים אל “Notice the change”, חלק 2 מתוך 3.");
  });
});
