import React, { useState } from "react";
import { MarkdownContent } from "./MarkdownContent";
import { mediaAvailability } from "../connected/resources";
import { YouTubePlayer } from "./YouTubePlayer.web";
import type { ReviewedMediaProps } from "./ReviewedMedia";
import { companionFocus } from "../client/companionFocus";
export function ReviewedMedia({
  media,
  accessClosed,
  now,
  required,
}: ReviewedMediaProps) {
  const [loadedKey, setLoadedKey] = useState(""),
    [position, setPosition] = useState<() => number | undefined>();
  const status = mediaAvailability(media, accessClosed, now, required);
  const key = JSON.stringify([media?.id, media?.url]);
  return (
    <section className="connected-media" aria-label="Course media">
      {status.reason && (
        <p className="connected-muted" role="status">
          {status.reason}
        </p>
      )}
      {status.videoId &&
        status.canLoad &&
        (loadedKey === key ? (
          <YouTubePlayer
            videoId={status.videoId}
            title="Course video"
            watchUrl={`https://www.youtube.com/watch?v=${status.videoId}`}
            onPosition={(read) => setPosition(() => read)}
          />
        ) : (
          <div className="connected-video-consent">
            <span aria-hidden="true">▷</span>
            <h3>Watch the course video</h3>
            <p>
              Load YouTube’s official player in privacy-enhanced mode when you’re
              ready. Loading it connects to YouTube; playback will not start
              automatically.
            </p>
            <button
              type="button"
              className="connected-button"
              onClick={() => setLoadedKey(key)}
            >
              Load reviewed video
            </button>
          </div>
        ))}
      {!status.videoId && status.canLoad && status.href && (
        <a href={status.href} target="_blank" rel="noopener noreferrer">
          Open reviewed media
          <span className="connected-sr"> (opens a new tab)</span>
        </a>
      )}
      {media && (
        <button
          type="button"
          className="connected-button"
          onClick={() => {
            const seconds = position?.();
            companionFocus.setMedia({
              mediaId: media.id,
              label: "Course video",
              ...(seconds !== undefined && Number.isFinite(seconds) && seconds >= 0
                ? { playbackSeconds: Math.round(seconds * 10) / 10 }
                : {}),
            });
          }}
        >
          Ask your companion about this video
          {position ? " at this point" : ""}
        </button>
      )}
      <div className="connected-media-text">
        <h3>Text alternative</h3>
        <MarkdownContent
          markdown={
            media?.alternativeMarkdown ||
            "A text alternative is not available. Contact your course team."
          }
        />
      </div>
      <p className="connected-muted">
        Loading or playing media does not record completion. Use the reading
        action after reviewing the material.
      </p>
    </section>
  );
}
