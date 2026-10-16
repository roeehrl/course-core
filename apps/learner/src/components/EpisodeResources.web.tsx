import React, { useEffect, useState } from "react";
import type { EpisodeResource, GeneratedMedia } from "../client/resourcesClient";
import type { EpisodeResourcesProps } from "./EpisodeResources";
import { YouTubePlayer } from "./YouTubePlayer.web";

/** 75 → "1:15", 3725 → "1:02:05". */
export function clock(seconds: number) {
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
/** Optional reviewed help. It never blocks the path, never records completion
 * and loads third-party players only after an explicit choice. */
export function EpisodeResources({ client, enrollmentId, episodeId }: EpisodeResourcesProps) {
  const [state, setState] = useState<{ items?: EpisodeResource[]; media?: GeneratedMedia[]; failed?: boolean }>({});
  const [loaded, setLoaded] = useState<string>();
  useEffect(() => {
    if (!client) return;
    const controller = new AbortController();
    setState({});
    setLoaded(undefined);
    // Course-made clips are separate: their absence or failure never hides reviewed sources.
    const media = client.media(enrollmentId, episodeId, controller.signal).catch(() => [] as GeneratedMedia[]);
    client
      .episode(enrollmentId, episodeId, controller.signal)
      .then(async (items) => {
        const clips = await media;
        if (!controller.signal.aborted) setState({ items, media: clips });
      })
      .catch(async () => {
        const clips = await media;
        if (!controller.signal.aborted) setState(clips.length ? { items: [], media: clips } : { failed: true });
      });
    return () => controller.abort();
  }, [client, enrollmentId, episodeId]);
  const total = (state.items?.length ?? 0) + (state.media?.length ?? 0);
  if (!client || (!state.failed && !total)) return null;
  return (
    <details className="connected-resources">
      <summary>
        <span>Optional help</span>
        <strong>
          {state.failed
            ? "Reviewed resources are unavailable right now"
            : `${total} reviewed resource${total === 1 ? "" : "s"} for this episode`}
        </strong>
      </summary>
      {state.failed ? (
        <p className="connected-muted">Your lesson and progress are unaffected. Try again later.</p>
      ) : (
        <>
          <p className="connected-muted">
            Chosen and reviewed by your course team for this episode. Opening them is optional and does not count
            toward progress or your understanding checks. A review checks relevance and rights; it is not a guarantee
            that every claim is correct.
          </p>
          <ul>
            {state.media!.map((clip) => (
              <li key={clip.id} className="connected-resource connected-generated">
                <h3>{clip.title}</h3>
                <p>
                  <span className="connected-resource-label">Course-made video. </span>
                  Generated for this lesson, then checked by your course team against the lesson before it was shared.
                </p>
                <p>
                  <span className="connected-resource-label">What it shows: </span>
                  {clip.objective}
                </p>
                <div className="connected-video connected-video-native">
                  <video controls preload="none" playsInline aria-label={clip.title}>
                    <source src={clip.assetUrl} type={clip.mimeType} />
                    <track kind="captions" src={clip.captionsUrl} srcLang="en" label="English captions" default />
                  </video>
                </div>
                <div className="connected-media-text">
                  <h4>Transcript</h4>
                  <p>{clip.transcript}</p>
                  <h4>What the video shows</h4>
                  <p>{clip.visualDescription}</p>
                </div>
              </li>
            ))}
            {state.items!.map((item) => (
              <li key={item.id} className="connected-resource">
                {item.suggestedFor.length > 0 && (
                  <p className="connected-resource-suggested">
                    <strong>Suggested for you.</strong> Your course companion picked this reviewed resource for what you’re
                    working on here. It’s still optional.
                  </p>
                )}
                <h3>{item.title}</h3>
                <p>
                  <span className="connected-resource-label">Why it may help: </span>
                  {item.whyUseful}
                </p>
                {item.excerpts.map((quote, index) => (
                  <blockquote key={index}>{quote}</blockquote>
                ))}
                {item.youtube?.segment && (
                  <p>
                    <span className="connected-resource-label">Reviewed part: </span>
                    {clock(item.youtube.segment.startSeconds)}–{clock(item.youtube.segment.endSeconds)}. The player starts and
                    stops there; the rest of the video was not reviewed.
                  </p>
                )}
                {item.youtube &&
                  (loaded === item.id ? (
                    <YouTubePlayer
                      videoId={item.youtube.videoId}
                      title={item.youtube.title}
                      watchUrl={item.url}
                      {...(item.youtube.segment
                        ? { startSeconds: item.youtube.segment.startSeconds, endSeconds: item.youtube.segment.endSeconds }
                        : {})}
                    />
                  ) : (
                    <button type="button" className="connected-button" onClick={() => setLoaded(item.id)}>
                      Load video player
                      <span className="connected-sr"> for {item.title}. This connects to YouTube; it will not autoplay.</span>
                    </button>
                  ))}
                {item.youtube && (
                  <div className="connected-media-text">
                    <h4>Written alternative</h4>
                    <p>{item.youtube.fallbackText}</p>
                  </div>
                )}
                <p className="connected-resource-meta">
                  <a href={item.url} target="_blank" rel="noopener noreferrer">
                    Open source
                    <span className="connected-sr"> (opens a new tab)</span>
                  </a>
                  {item.attributions.length > 0 && (
                    <span>
                      {" · "}
                      {item.attributions.map((a) => [a.authorName, a.providerName].filter(Boolean).join(", ")).join("; ")}
                    </span>
                  )}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </details>
  );
}
