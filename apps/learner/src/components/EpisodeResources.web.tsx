import React, { useEffect, useState } from "react";
import type { EpisodeResource } from "../client/resourcesClient";
import type { EpisodeResourcesProps } from "./EpisodeResources";

/** Optional reviewed help. It never blocks the path, never records completion
 * and loads third-party players only after an explicit choice. */
export function EpisodeResources({ client, enrollmentId, episodeId }: EpisodeResourcesProps) {
  const [state, setState] = useState<{ items?: EpisodeResource[]; failed?: boolean }>({});
  const [loaded, setLoaded] = useState<string>();
  useEffect(() => {
    if (!client) return;
    const controller = new AbortController();
    setState({});
    setLoaded(undefined);
    client
      .episode(enrollmentId, episodeId, controller.signal)
      .then((items) => !controller.signal.aborted && setState({ items }))
      .catch(() => !controller.signal.aborted && setState({ failed: true }));
    return () => controller.abort();
  }, [client, enrollmentId, episodeId]);
  if (!client || (!state.failed && !state.items?.length)) return null;
  return (
    <details className="connected-resources">
      <summary>
        <span>Optional help</span>
        <strong>
          {state.failed
            ? "Reviewed resources are unavailable right now"
            : `${state.items!.length} reviewed resource${state.items!.length === 1 ? "" : "s"} for this episode`}
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
            {state.items!.map((item) => (
              <li key={item.id} className="connected-resource">
                <h3>{item.title}</h3>
                <p>
                  <span className="connected-resource-label">Why it may help: </span>
                  {item.whyUseful}
                </p>
                {item.excerpts.map((quote, index) => (
                  <blockquote key={index}>{quote}</blockquote>
                ))}
                {item.youtube &&
                  (loaded === item.id ? (
                    <div className="connected-video">
                      <iframe
                        title={item.youtube.title}
                        src={item.youtube.embedSrc}
                        loading="lazy"
                        referrerPolicy="strict-origin-when-cross-origin"
                        sandbox="allow-scripts allow-same-origin allow-presentation"
                        allow="fullscreen; encrypted-media; picture-in-picture"
                        allowFullScreen
                      />
                    </div>
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
