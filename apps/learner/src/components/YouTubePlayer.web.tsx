import React, { useEffect, useRef, useState } from "react";

/** The documented surface of YouTube's IFrame Player API that this player uses. */
interface YTPlayer {
  destroy(): void;
  getIframe?(): HTMLIFrameElement;
  getCurrentTime?(): number;
}
interface YTPlayerEvent {
  target: YTPlayer;
  data?: number;
}
export interface YTNamespace {
  Player: new (
    element: HTMLElement,
    options: {
      host: string;
      videoId: string;
      width: string;
      height: string;
      playerVars: Record<string, string | number>;
      events: {
        onReady?: (event: YTPlayerEvent) => void;
        onError?: (event: YTPlayerEvent) => void;
      };
    },
  ) => YTPlayer;
}
declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

export const YOUTUBE_API_SRC = "https://www.youtube.com/iframe_api";
/** Privacy-enhanced playback host. It still contacts YouTube once loaded. */
export const YOUTUBE_PLAYER_HOST = "https://www.youtube-nocookie.com";
let pending: Promise<YTNamespace> | undefined;

/** Loads the official IFrame Player API once. A blocked or slow script rejects
 * so the caller can show the written route instead of an empty frame. */
export function loadYouTubeApi(timeoutMs = 15_000): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (pending) return pending;
  pending = new Promise<YTNamespace>((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    const fail = (code: string) => {
      clearTimeout(timer);
      pending = undefined;
      reject(new Error(code));
    };
    const timer = setTimeout(() => fail("YOUTUBE_API_TIMEOUT"), timeoutMs);
    window.onYouTubeIframeAPIReady = () => {
      try {
        previous?.();
      } catch {
        /* another page script's callback cannot block playback */
      }
      clearTimeout(timer);
      if (window.YT?.Player) resolve(window.YT);
      else fail("YOUTUBE_API_INVALID");
    };
    const script = document.createElement("script");
    script.src = YOUTUBE_API_SRC;
    script.async = true;
    script.onerror = () => {
      script.remove();
      fail("YOUTUBE_API_BLOCKED");
    };
    document.head.appendChild(script);
  });
  return pending;
}
export type PlayerFailure = number | "load";
/** Player error codes from the IFrame API reference, in plain language. */
export function playerErrorMessage(code: PlayerFailure): string {
  switch (code) {
    case 2:
      return "The video link is not valid.";
    case 5:
      return "Your browser could not play this video.";
    case 100:
      return "The video was removed or made private.";
    case 101:
    case 150:
      return "The video's owner does not allow it to play on other sites.";
    case 153:
      return "YouTube could not identify this site, so it would not play the video here.";
    case "load":
      return "The YouTube player could not load. It may be blocked on this network or by a browser setting.";
    default:
      return "The video could not play here.";
  }
}

export interface YouTubePlayerProps {
  videoId: string;
  title: string;
  watchUrl: string;
  /** Called once with the failure so a host can record it; never a progress signal. */
  onFailure?: (code: PlayerFailure) => void;
  /** Gives the host a reader of the current playback position (seconds) once the player is ready. */
  onPosition?: (read: () => number | undefined) => void;
  /** A reviewed segment: playback starts and stops there. The learner can still seek. */
  startSeconds?: number;
  endSeconds?: number;
}
/** Official player with error handling: a removed, private, embedding-disabled or
 * blocked video becomes a message, a link and the written route. Never autoplays. */
export function YouTubePlayer({ videoId, title, watchUrl, onFailure, onPosition, startSeconds, endSeconds }: YouTubePlayerProps) {
  const host = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState<PlayerFailure>();
  const report = useRef(onFailure);
  report.current = onFailure;
  const position = useRef(onPosition);
  position.current = onPosition;
  useEffect(() => {
    let player: YTPlayer | undefined;
    let cancelled = false;
    setFailure(undefined);
    const fail = (code: PlayerFailure) => {
      if (cancelled) return;
      setFailure(code);
      report.current?.(code);
    };
    const name = () => player?.getIframe?.()?.setAttribute("title", title);
    loadYouTubeApi()
      .then((YT) => {
        if (cancelled || !host.current) return;
        const target = document.createElement("div");
        host.current.replaceChildren(target);
        try {
          player = new YT.Player(target, {
            host: YOUTUBE_PLAYER_HOST,
            videoId,
            width: "100%",
            height: "100%",
            playerVars: {
              autoplay: 0,
              playsinline: 1,
              rel: 0,
              origin: window.location.origin,
              ...(startSeconds !== undefined ? { start: startSeconds } : {}),
              ...(endSeconds !== undefined ? { end: endSeconds } : {}),
            },
            events: {
              onReady: () => {
                name();
                position.current?.(() => {
                  try {
                    const seconds = player?.getCurrentTime?.();
                    return typeof seconds === "number" && Number.isFinite(seconds) ? seconds : undefined;
                  } catch {
                    return undefined;
                  }
                });
              },
              onError: (event) => fail(typeof event.data === "number" ? event.data : 5),
            },
          });
          name();
        } catch {
          fail("load");
        }
      })
      .catch(() => fail("load"));
    return () => {
      cancelled = true;
      try {
        player?.destroy();
      } catch {
        /* the frame may already be gone */
      }
    };
  }, [videoId, title, startSeconds, endSeconds]);
  if (failure !== undefined)
    return (
      <div className="connected-video-error" role="status">
        <p>
          <strong>This video can’t play here.</strong> {playerErrorMessage(failure)}
        </p>
        <p>
          Your place in the lesson is kept, and nothing is marked as missed. Use the written alternative, or{" "}
          <a href={watchUrl} target="_blank" rel="noopener noreferrer">
            open the video on YouTube
            <span className="connected-sr"> (opens a new tab)</span>
          </a>
          .
        </p>
      </div>
    );
  return (
    <div className="connected-video">
      <div ref={host} className="connected-video-host" data-video-id={videoId} />
    </div>
  );
}
/** Test seam only: forget a cached loader between isolated tests. */
export function resetYouTubeApiForTests() {
  pending = undefined;
}
