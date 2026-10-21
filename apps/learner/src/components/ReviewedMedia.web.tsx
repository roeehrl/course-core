import React, { useState } from "react";
import { MarkdownContent } from "./MarkdownContent";
import { mediaAvailability } from "../connected/resources";
import { YouTubePlayer } from "./YouTubePlayer.web";
import type { ReviewedMediaProps } from "./ReviewedMedia";
import { companionFocus } from "../client/companionFocus";
import { useT } from "../i18n";
export function ReviewedMedia({
  media,
  accessClosed,
  now,
  required,
  companionAvailable = true,
}: ReviewedMediaProps) {
  const t = useT();
  const [loadedKey, setLoadedKey] = useState(""),
    [position, setPosition] = useState<() => number | undefined>();
  const status = mediaAvailability(media, accessClosed, now, required);
  const key = JSON.stringify([media?.id, media?.url]);
  return (
    <section className="connected-media" aria-label={t("reviewedMedia.region")}>
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
            title={t("reviewedMedia.video")}
            watchUrl={`https://www.youtube.com/watch?v=${status.videoId}`}
            onPosition={(read) => setPosition(() => read)}
          />
        ) : (
          <div className="connected-video-consent">
            <span aria-hidden="true">▷</span>
            <h3>{t("reviewedMedia.consent.title")}</h3>
            <p>{t("reviewedMedia.consent.body")}</p>
            <button
              type="button"
              className="connected-button"
              onClick={() => setLoadedKey(key)}
            >
              {t("reviewedMedia.load")}
            </button>
          </div>
        ))}
      {!status.videoId && status.canLoad && status.href && (
        <a href={status.href} target="_blank" rel="noopener noreferrer">
          {t("reviewedMedia.open")}
          <span className="connected-sr">{t("reviewedMedia.newTab")}</span>
        </a>
      )}
      {media && companionAvailable && (
        <button
          type="button"
          className="connected-button"
          onClick={() => {
            const seconds = position?.();
            companionFocus.setMedia({
              mediaId: media.id,
              label: t("reviewedMedia.video"),
              ...(seconds !== undefined && Number.isFinite(seconds) && seconds >= 0
                ? { playbackSeconds: Math.round(seconds * 10) / 10 }
                : {}),
            });
          }}
        >
          {position ? t("reviewedMedia.askAtPoint") : t("reviewedMedia.ask")}
        </button>
      )}
      <div className="connected-media-text">
        <h3>{t("reviewedMedia.alternative")}</h3>
        <MarkdownContent
          markdown={
            media?.alternativeMarkdown || t("reviewedMedia.noAlternative")
          }
        />
      </div>
      <p className="connected-muted">
        {t("reviewedMedia.noCompletion")}
      </p>
    </section>
  );
}
