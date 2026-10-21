import type { MediaResource } from "@course-core/sdk";
import { englishTranslator, type Translate } from "../i18n";

/** Only explicit HTTPS links can navigate. Private URNs and markup stay labels. */
export function safeHttpsUrl(value: string | undefined): string | undefined {
  if (
    !value ||
    /[\u0000-\u0020\u007f\\]/.test(value) ||
    !value.startsWith("https://")
  )
    return;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !url.hostname
    )
      return;
    return url.href;
  } catch {
    return;
  }
}
export function youtubeVideoId(value: string): string | undefined {
  const safe = safeHttpsUrl(value);
  if (!safe) return;
  const url = new URL(safe);
  if (url.port) return;
  let id: string | null | undefined;
  if (url.hostname === "youtu.be")
    id = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
  else if (
    [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "www.youtube-nocookie.com",
    ].includes(url.hostname)
  ) {
    if (
      url.hostname !== "www.youtube-nocookie.com" &&
      url.pathname === "/watch"
    )
      id = url.searchParams.get("v");
    else
      id = /^\/(?:embed|shorts)\/([A-Za-z0-9_-]{11})\/?$/.exec(
        url.pathname,
      )?.[1];
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : undefined;
}
/** Recognize explicit URL expiry only; SDK 0.1.0 has no media expiresAt field. */
export function mediaUrlExpiry(value: string): number | undefined {
  const safe = safeHttpsUrl(value);
  if (!safe) return;
  const url = new URL(safe);
  const entries = [...url.searchParams].filter(([key]) =>
    ["expires", "expire"].includes(key.toLowerCase()),
  );
  if (!entries.length) return;
  const dates = entries.map(([, raw]) =>
    /^\d+$/.test(raw)
      ? Number(raw) * (raw.length <= 10 ? 1000 : 1)
      : Date.parse(raw),
  );
  return dates.every(Number.isFinite) ? Math.min(...dates) : 0;
}
export interface MediaAvailability {
  canAcknowledge: boolean;
  canLoad: boolean;
  reason?: string;
  videoId?: string;
  href?: string;
}
export function mediaAvailability(
  media: MediaResource | undefined,
  accessClosed = false,
  now = Date.now(),
  required = true,
  t: Translate = englishTranslator().t,
): MediaAvailability {
  if (!media)
    return {
      canAcknowledge: false,
      canLoad: false,
      reason: t("resources.missing"),
    };
  const blocked = (reason: string): MediaAvailability => ({
    canAcknowledge: !required && !accessClosed,
    canLoad: false,
    reason,
  });
  if (accessClosed)
    return blocked(t("resources.accessClosed"));
  if (media.review !== "reviewed")
    return blocked(
      t("resources.awaitingReview"),
    );
  const href = safeHttpsUrl(media.url),
    expiry = mediaUrlExpiry(media.url);
  if (expiry !== undefined && expiry <= now)
    return blocked(
      t("resources.expired"),
    );
  if (!href)
    return blocked(
      t("resources.unsafe"),
    );
  const videoId = media.type === "youtube" ? youtubeVideoId(href) : undefined;
  if (media.type === "youtube" && !videoId)
    return blocked(
      t("resources.unsupportedVideo"),
    );
  return { canAcknowledge: true, canLoad: true, href, videoId };
}
