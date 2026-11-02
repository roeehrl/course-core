import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { companionFocus } from "../src/client/companionFocus";
import { ReviewedMedia } from "../src/components/ReviewedMedia.web";
import { companionBridge, resetCompanionBridge, type ComposeRequest } from "../src/connected/companion/bridge";
import { companionOpen } from "../src/connected/companion/openState";
import { installFakeYouTube } from "./youtubeFake";

const media = {
  id: "clip",
  type: "youtube",
  sourceRef: "s1",
  url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  review: "reviewed",
  alternativeMarkdown: "A described clip.",
  generated: false,
} as never;

afterEach(() => {
  resetCompanionBridge();
  companionOpen.reset();
  companionFocus.clear();
});

async function loadPlayer() {
  fireEvent.click(screen.getByRole("button", { name: "Load reviewed video" }));
  await act(async () => {});
}

describe("controls pointing at the companion", () => {
  it("a reviewed video offers 'Ask about this moment' only where the companion is available", async () => {
    const youtube = installFakeYouTube();
    try {
      const { rerender } = render(<ReviewedMedia media={media} />);
      // Not before the player is loaded: there is no moment yet.
      expect(screen.queryByRole("button", { name: "Ask about this moment" })).toBeNull();
      await loadPlayer();
      // The study arm offers no companion: nothing points at it.
      expect(screen.queryByRole("button", { name: /companion|this moment/i })).toBeNull();
      act(() => companionBridge.setAvailable(true));
      expect(screen.getByRole("button", { name: "Ask about this moment" })).toBeVisible();
      rerender(<ReviewedMedia media={media} companionAvailable={false} />);
      expect(screen.queryByRole("button", { name: /companion|this moment/i })).toBeNull();
      expect(screen.getByText("A described clip.")).toBeVisible();
    } finally {
      youtube.remove();
    }
  });

  it("'Ask about this moment' attaches the video at the player's time and opens the companion", async () => {
    const youtube = installFakeYouTube();
    (window.YT!.Player.prototype as { getCurrentTime?: () => number }).getCurrentTime = () => 134.04;
    const requests: ComposeRequest[] = [];
    companionBridge.setAvailable(true);
    companionBridge.onCompose((request) => requests.push(request));
    try {
      render(<ReviewedMedia media={media} />);
      await loadPlayer();
      const ask = screen.getByRole("button", { name: "Ask about this moment" });
      expect(ask.closest(".cc-ask-media-bar")).not.toBeNull();
      expect(ask.querySelector('[data-icon="sparkle"]')).not.toBeNull();
      fireEvent.click(ask);
      expect(companionFocus.get().media).toEqual({ mediaId: "clip", label: "Course video", playbackSeconds: 134 });
      expect(requests).toEqual([{ source: "video", focus: true }]);
      expect(companionOpen.get().open || companionOpen.get().sheetOpen).toBe(true);
    } finally {
      youtube.remove();
    }
  });
});
