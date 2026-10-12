import React, { useState } from "react";
import { MarkdownContent } from "./MarkdownContent";
import { mediaAvailability } from "../connected/resources";
import type { ReviewedMediaProps } from "./ReviewedMedia";
export function ReviewedMedia({
  media,
  accessClosed,
  now,
  required,
}: ReviewedMediaProps) {
  const [loadedKey, setLoadedKey] = useState("");
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
          <div className="connected-video">
            <iframe
              title="Course video"
              src={`https://www.youtube-nocookie.com/embed/${status.videoId}?autoplay=0&rel=0`}
              loading="lazy"
              referrerPolicy="strict-origin-when-cross-origin"
              sandbox="allow-scripts allow-same-origin allow-presentation"
              allow="fullscreen; picture-in-picture"
              allowFullScreen
            />
          </div>
        ) : (
          <div className="connected-video-consent">
            <span aria-hidden="true">▷</span>
            <h3>Watch the course video</h3>
            <p>
              Load YouTube’s privacy-enhanced player when you’re ready. Loading
              it connects to YouTube; playback will not start automatically.
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
