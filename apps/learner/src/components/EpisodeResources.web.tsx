import React, { useEffect, useState } from "react";
import type { EpisodeResource, GeneratedMedia } from "../client/resourcesClient";
import type { EpisodeResourcesProps } from "./EpisodeResources";
import { useI18n } from "../i18n";
import { YouTubePlayer } from "./YouTubePlayer.web";
import { Icon } from "./icons/Icon.web";

/** 75 → "1:15", 3725 → "1:02:05". */
export function clock(seconds: number) {
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
/** Optional reviewed help (§4.7). It never blocks the path, never records completion and loads
 * third-party players only after an explicit choice. Each resource is a row of the list; the
 * companion's pick carries a "Suggested for you" chip and the reason it may help. */
export function EpisodeResources({ client, enrollmentId, episodeId }: EpisodeResourcesProps) {
  const i18n = useI18n(),
    t = i18n.t;
  const label = (children: React.ReactNode, key: string) => (
    <span key={key} className="connected-resource-label">
      {children}
    </span>
  );
  const sr = (children: React.ReactNode, key: string) => (
    <span key={key} className="connected-sr">
      {children}
    </span>
  );
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
  if (state.failed)
    return (
      <section className="connected-resources is-unavailable" aria-labelledby={`resources-${episodeId}`}>
        <p id={`resources-${episodeId}`} className="connected-resources-title">{t("episodeResources.summary")}</p>
        <p className="cc-ui-status">
          <Icon name="info" size={16} />
          <span>{t("episodeResources.unavailable")}</span>
        </p>
      </section>
    );
  return (
    <details className="connected-resources">
      <summary>
        <span className="connected-resources-title">{t("episodeResources.summary")}</span>
        <span className="connected-resources-count">{t("episodeResources.count", { total })}</span>
      </summary>
      <p className="connected-resources-intro">{t("episodeResources.intro")}</p>
      <ul aria-label={t("episodeResources.summary")}>
        {state.media!.map((clip) => (
          <li key={clip.id} className="connected-resource connected-generated">
            <Icon name="play" size={20} />
            <div className="connected-resource-body">
              <h3 dir="auto">{clip.title}</h3>
              <p className="connected-resource-made">{i18n.rich("episodeResources.generated", undefined, { label })}</p>
              <p className="connected-resource-meta">{i18n.rich("episodeResources.whatItShows", { objective: clip.objective }, { label })}</p>
              {clip.captionsUrl ? (
                <>
                  <div className="connected-video connected-video-native">
                    <video controls preload="none" playsInline aria-label={clip.title}>
                      <source src={clip.assetUrl} type={clip.mimeType} />
                      <track kind="captions" src={clip.captionsUrl} srcLang={clip.captionsLanguage} label={t("episodeResources.captions")} default />
                    </video>
                  </div>
                  <div className="connected-media-text">
                    <h4>{t("episodeResources.transcript")}</h4>
                    <p dir="auto">{clip.transcript}</p>
                    <h4>{t("episodeResources.videoShows")}</h4>
                    <p dir="auto">{clip.visualDescription}</p>
                  </div>
                </>
              ) : (
                <figure className="connected-generated-image">
                  <img src={clip.assetUrl} alt={clip.visualDescription} loading="lazy" />
                  <figcaption dir="auto">{t("episodeResources.imageShows")} {clip.visualDescription}</figcaption>
                </figure>
              )}
            </div>
          </li>
        ))}
        {state.items!.map((item) => (
          <li key={item.id} className="connected-resource">
            <Icon name={item.youtube ? "play" : "book-open"} size={20} />
            <div className="connected-resource-body">
              <h3 dir="auto">{item.title}</h3>
              {item.suggestedFor.length > 0 && (
                <p className="connected-resource-suggested">
                  <Icon name="sparkle" size={16} />
                  {t("episodeResources.suggested")}
                </p>
              )}
              <p className="connected-resource-why">{t("episodeResources.whyHelp", { why: item.whyUseful })}</p>
              {item.excerpts.map((quote, index) => (
                <blockquote key={index} dir="auto">
                  {quote}
                </blockquote>
              ))}
              {item.youtube?.segment && (
                <p className="connected-resource-meta">
                  {i18n.rich(
                    "episodeResources.reviewedPart",
                    {
                      start: clock(item.youtube.segment.startSeconds),
                      end: clock(item.youtube.segment.endSeconds),
                    },
                    { label },
                  )}
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
                  <button type="button" className="cc-ui-pill cc-ui-pill-outline cc-ui-pill-36 connected-resource-load" onClick={() => setLoaded(item.id)}>
                    <Icon name="play" size={16} />
                    <span>{i18n.rich("episodeResources.loadPlayer", { title: item.title }, { sr })}</span>
                  </button>
                ))}
              {item.youtube && (
                <div className="connected-media-text">
                  <h4>{t("episodeResources.writtenAlternative")}</h4>
                  <p dir="auto">{item.youtube.fallbackText}</p>
                </div>
              )}
              <p className="connected-resource-meta">
                <a href={item.url} target="_blank" rel="noopener noreferrer">
                  {i18n.rich("episodeResources.openSource", undefined, { sr })}
                  <Icon name="external-link" size={16} />
                </a>
                {item.attributions.length > 0 && (
                  <span dir="auto">
                    {" · "}
                    {item.attributions.map((a) => [a.authorName, a.providerName].filter(Boolean).join(", ")).join("; ")}
                  </span>
                )}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}
