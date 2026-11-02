import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  ConnectedLesson,
  returnPoint,
  type ConnectedLessonProps,
} from "../src/connected/ConnectedLesson.web";
import { stripBidiControls } from "@course-core/i18n";
import { I18nProvider, createLearnerTranslator } from "../src/i18n";
import { connectedSnapshot } from "./connectedFixtures";
import { lessonNavigator, resetCompanionBridge } from "../src/connected/companion/bridge";
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
    check: { onStart: vi.fn(), onAnswer: vi.fn(), onSolution: vi.fn() },
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
    render(<ConnectedLesson {...p}/>);fireEvent.click(screen.getByRole('button',{name:'Get a fresh check · 2 min'}));expect(p.check.onStart).toHaveBeenCalledOnce();expect(screen.getByRole('button',{name:'Finish this lesson →'})).toBeDisabled();
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
  it("says the lesson is an optional detour in one row of the header, and takes the learner back", () => {
    const p = detour();
    expect(returnPoint(p.server, p.episode, false)).toEqual({ kind: "optional", episodeId: "intro", title: "Notice the change", where: "part", part: 2, total: 3 });
    render(<ConnectedLesson {...p} />);
    const banner = screen.getByTestId("detour-return");
    expect(banner).toHaveAttribute("role", "note");
    expect(banner.closest("header")).toHaveClass("connected-lesson-heading");
    expect(banner).toHaveTextContent("You're on an optional detour.");
    const back = screen.getByRole("button", { name: "Back to Notice the change" });
    // The arrow points along the reading direction (mirrored in right-to-left text).
    expect(back.querySelector('svg[data-icon="arrow-right"]')).toHaveClass("cc-ui-icon-mirror");
    fireEvent.click(back);
    expect(p.onReturn).toHaveBeenCalledWith("intro");
  });
  it("names the check when every part is read, and a revisit of a finished lesson", () => {
    const p = detour();
    p.server.lessons[0]!.completedBlockIds = ["reading", "picture", "movie"];
    expect(returnPoint(p.server, p.episode, false)).toMatchObject({ where: "check" });
    p.episode = { ...p.episode, requirement: "required" };
    p.server.lessons[1]!.status = "completed";
    render(<ConnectedLesson {...p} />);
    expect(screen.getByTestId("detour-return")).toHaveTextContent("You're revisiting a lesson you finished.");
    expect(screen.getByRole("button", { name: "Back to Notice the change" })).toBeVisible();
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
    expect(stripBidiControls(screen.getByTestId("detour-return").textContent ?? "")).toContain("זה מסלול צדדי, לא חובה.");
    // No ל glued to the lesson's name (§7).
    expect(stripBidiControls(screen.getByTestId("detour-return").querySelector("button")!.textContent ?? "")).toBe("חזרה אל Notice the change");
  });
});

describe("a lesson part shown from elsewhere (companion sources, new material)", () => {
  afterEach(() => resetCompanionBridge());
  it("shows a part read before or the next one to read, scrolls to it and highlights it; never a later unread part", async () => {
    const p = props();
    p.server.lessons[0]!.completedBlockIds = ["reading"];
    const scroll = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    onTestFinished(() => {
      Element.prototype.scrollIntoView = original;
    });
    // As in the host: the lesson sits in its keeper.
    render(<div className="connected-lesson-keeper"><ConnectedLesson {...p} /></div>);
    expect(screen.getByRole("article", { name: "Reading part 2" })).toBeVisible();
    // A later part the learner has not reached stays closed.
    expect(lessonNavigator.show({ episodeId: "intro", blockId: "movie" })).toBe(false);
    await act(async () => {
      expect(lessonNavigator.show({ episodeId: "intro", blockId: "reading", focus: "block" })).toBe(true);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    const card = screen.getByRole("article", { name: "Reading part 1" });
    expect(scroll).toHaveBeenCalled();
    expect(card).toHaveAttribute("data-cc-highlight", "hold");
    expect(card).toHaveFocus();
  });
});
