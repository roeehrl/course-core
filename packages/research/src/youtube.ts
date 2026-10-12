import { requireResearch } from './errors.js';
import { publicHttpsUrl } from './urls.js';
import { parse, transcriptSchema, validateAttribution, type AuthorizedTranscript, type SourceAttribution, type YouTubeDescriptor } from './contracts.js';

const videoId = /^[A-Za-z0-9_-]{11}$/;
export function parseYouTubeId(input: string): string {
  if (typeof input === 'string' && videoId.test(input)) return input;
  const url = publicHttpsUrl(input, true);
  requireResearch(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtube-nocookie.com', 'youtube-nocookie.com'].includes(url.hostname), 'URL_REJECTED');
  const path = url.pathname.split('/').filter(Boolean);
  let id: string | null = null;
  if (url.hostname === 'youtu.be' && path.length === 1) id = path[0]!;
  else if (url.pathname === '/watch' && !url.hostname.includes('nocookie') && url.searchParams.getAll('v').length === 1) id = url.searchParams.get('v');
  else if (path.length === 2 && ['embed', 'shorts', 'live'].includes(path[0]!) && (!url.hostname.includes('nocookie') || path[0] === 'embed')) id = path[1]!;
  requireResearch(id && videoId.test(id) && [...url.searchParams.keys()].every(key => ['v', 't', 'start', 'si', 'feature'].includes(key)) &&
    !url.pathname.includes('//') && !url.pathname.includes('%'), 'URL_REJECTED');
  return id;
}
/** Descriptor only: no iframe HTML, script, playback or transcript scraping. A
 * privacy-enhanced embed still contacts YouTube after explicit activation. */
export function youtubeDescriptor(input: {
  urlOrId: string; title?: string; attribution?: SourceAttribution; transcript?: AuthorizedTranscript;
  fallback?: { text: string; reference: string };
}): YouTubeDescriptor {
  const id = parseYouTubeId(input.urlOrId), title = input.title ?? 'YouTube video';
  requireResearch(typeof title === 'string' && title.length > 0 && title.length <= 300, 'INVALID_INPUT');
  const transcript = input.transcript ? parse(transcriptSchema, input.transcript) : undefined;
  if (input.fallback) requireResearch(input.fallback.text.length > 0 && input.fallback.text.length <= 10000 && input.fallback.reference.length > 0 && input.fallback.reference.length <= 500, 'INVALID_INPUT');
  return { videoId: id, watchUrl: `https://www.youtube.com/watch?v=${id}`,
    embed: { src: `https://www.youtube-nocookie.com/embed/${id}?playsinline=1&rel=0`, title, aspectRatio: '16:9',
      requiresUserActivation: true, referrerPolicy: 'strict-origin-when-cross-origin', allow: 'fullscreen; encrypted-media; picture-in-picture', loading: 'lazy' },
    attribution: input.attribution ? validateAttribution(input.attribution) : null,
    transcript: transcript ? { status: 'provided_with_rights', language: transcript.language, obtainedVia: transcript.obtainedVia, rights: transcript.rights } : { status: 'not_provided' },
    fallback: input.fallback ? { text: input.fallback.text, source: 'author', reference: input.fallback.reference }
      : { text: 'Open the video on YouTube, or ask the course author for an accessible written alternative.', source: 'default', reference: null } };
}
