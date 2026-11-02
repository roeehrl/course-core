import { describe, expect, it } from "vitest";
import type { CompanionMessage } from "../src/client/companionClient";
import { turnAnchor } from "../src/connected/companion/LearnerTurn.web";
import { createLearnerTranslator } from "../src/i18n";

const t = createLearnerTranslator("en").t;
const question = (context: CompanionMessage["context"]): CompanionMessage => ({ id: "q", role: "learner", content: "Why?", context, created_at: "2026-11-01T10:00:00Z" });

// The anchor chip above a sent question (final design §3.3, §3.9): what the learner attached, and a
// way back to it in the lesson.
describe("the anchor chip of a sent question", () => {
  it("shows a video moment and goes back to the video's block", () => {
    const anchor = turnAnchor(question({ episodeId: "min", mediaRef: { mediaId: "walkthrough", blockId: "video-block", playbackSeconds: 83 } }), t);
    expect(anchor?.label).toBe("Course video, 1:23");
    expect(anchor?.target).toEqual({ episodeId: "min", blockId: "video-block", focus: "block" });
  });

  it("names the part of the illustration the composer's chip named", () => {
    const anchor = turnAnchor(question({ episodeId: "min", selectedAnchor: { kind: "visual_node", blockId: "scene", label: "Hidden layer" } }), t);
    expect(anchor?.label).toBe("Part of the illustration: Hidden layer");
    expect(anchor?.target).toEqual({ episodeId: "min", blockId: "scene", focus: "block" });
    // An older row stored without the label still says what it is.
    expect(turnAnchor(question({ selectedAnchor: { kind: "visual_node", blockId: "scene" } }), t)?.label).toBe("Part of the illustration");
  });
});
