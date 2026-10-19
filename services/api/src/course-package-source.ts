/**
 * Remote course-package sources. Only public GitHub releases are supported, and only these hosts
 * are ever contacted, over https: api.github.com (release metadata), github.com (the release's
 * download URL) and the GitHub release-asset hosts github.com redirects downloads to. A
 * user-supplied URL is parsed into owner/repo/tag/asset and never fetched as given; every redirect
 * hop is checked against the allowlist (at most 5), no cookies or credentials are sent, and every
 * response is read as a bounded stream with connect and read timeouts.
 *
 * Operator switch: COURSE_PACKAGE_REMOTE_FETCH=github (default) | off.
 */
import { ApiError } from './errors.js';
import { COURSE_PACKAGE_LIMITS, sha256 } from './course-package.js';

export type RemoteFetchMode = 'github' | 'off';
export function remoteFetchMode(value: string | undefined): RemoteFetchMode {
  if (value === undefined || value === '' || value === 'github') return 'github';
  if (value === 'off') return 'off';
  throw new Error('COURSE_PACKAGE_REMOTE_FETCH must be "github" or "off".');
}

/** Same shape as the WHATWG fetch subset used here; tests inject a fake. */
export type PackageFetcher = (url: string, init: { method: 'GET'; redirect: 'manual'; headers: Record<string, string>; signal: AbortSignal; credentials: 'omit' }) => Promise<Response>;
export interface RemoteFetchOptions {
  fetcher?: PackageFetcher;
  /** Time allowed until response headers arrive (each hop). */
  connectTimeoutMs?: number;
  /** Longest pause between two body chunks. */
  readTimeoutMs?: number;
  /** Whole-download ceiling. */
  totalTimeoutMs?: number;
}
export const ALLOWED_HOSTS = Object.freeze(['api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com']);
const MAX_REDIRECTS = 5;
const API_JSON_LIMIT = 2 * 1024 * 1024;
const CHECKSUM_LIMIT = 4096;

const remoteError = (status: number, code: string, details?: Record<string, unknown>) => new ApiError(status, code, code, details);

export interface GitHubReference { owner: string; repo: string; tag: string | null; asset: string | null }
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, REPO = /^[A-Za-z0-9._-]{1,100}$/, TAG = /^[A-Za-z0-9._+-][A-Za-z0-9._+/-]{0,199}$/, ASSET = /^[A-Za-z0-9._+-]{1,200}$/;
/**
 * Accepts https://github.com/<owner>/<repo>, …/releases, …/releases/latest, …/releases/tag/<tag>
 * and …/releases/download/<tag>/<asset>. Anything else is refused before any network access.
 */
export function parseGitHubUrl(input: string): GitHubReference {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw remoteError(400, 'COURSE_PACKAGE_URL_UNSUPPORTED'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash)
    throw remoteError(400, 'COURSE_PACKAGE_URL_UNSUPPORTED');
  const parts = url.pathname.replace(/\/+$/, '').split('/').slice(1).map(part => decodeURIComponent(part));
  const [owner, rawRepo, releases, kind, ...rest] = parts;
  const repo = rawRepo?.replace(/\.git$/, '');
  if (!owner || !repo || !OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') throw remoteError(400, 'COURSE_PACKAGE_URL_UNSUPPORTED');
  const reference = (tag: string | null, asset: string | null) => {
    if ((tag !== null && (!TAG.test(tag) || tag.split('/').includes('..'))) || (asset !== null && !ASSET.test(asset))) throw remoteError(400, 'COURSE_PACKAGE_URL_UNSUPPORTED');
    return { owner, repo, tag, asset };
  };
  if (releases === undefined) return reference(null, null);
  if (releases !== 'releases') throw remoteError(400, 'COURSE_PACKAGE_URL_UNSUPPORTED');
  if (kind === undefined || (kind === 'latest' && !rest.length)) return reference(null, null);
  if (kind === 'tag' && rest.length >= 1) return reference(rest.join('/'), null);
  if (kind === 'download' && rest.length >= 2) return reference(rest.slice(0, -1).join('/'), rest.at(-1)!);
  throw remoteError(400, 'COURSE_PACKAGE_URL_UNSUPPORTED');
}

function allowed(url: URL) {
  return url.protocol === 'https:' && !url.port && !url.username && !url.password && ALLOWED_HOSTS.includes(url.hostname);
}
async function timed<T>(promise: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(remoteError(504, 'COURSE_PACKAGE_FETCH_TIMEOUT')); controller.abort(); }, ms); })]);
  } finally { clearTimeout(timer); }
}

/** GETs an allowlisted https URL, following at most 5 allowlisted redirects, reading at most `limit` bytes. */
export async function fetchBounded(start: string, limit: number, options: RemoteFetchOptions, accept: string): Promise<{ status: number; body: Buffer; finalUrl: string }> {
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const connectMs = options.connectTimeoutMs ?? 15_000, readMs = options.readTimeoutMs ?? 30_000, totalMs = options.totalTimeoutMs ?? 180_000;
  const controller = new AbortController(), deadline = Date.now() + totalMs;
  const remaining = (ms: number) => Math.max(1, Math.min(ms, deadline - Date.now()));
  let current = new URL(start);
  try {
    for (let hop = 0; ; hop++) {
      if (!allowed(current)) throw remoteError(502, 'COURSE_PACKAGE_REDIRECT_REFUSED', { host: current.hostname.slice(0, 253) });
      let response: Response;
      try {
        response = await timed(fetcher(current.toString(), { method: 'GET', redirect: 'manual', credentials: 'omit', signal: controller.signal,
          headers: { accept, 'user-agent': 'course-core-package-installer', ...(current.hostname === 'api.github.com' ? { 'x-github-api-version': '2022-11-28' } : {}) } }), remaining(connectMs), controller);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw remoteError(502, 'COURSE_PACKAGE_FETCH_FAILED');
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get('location');
        if (!location) throw remoteError(502, 'COURSE_PACKAGE_FETCH_FAILED');
        if (hop + 1 > MAX_REDIRECTS) throw remoteError(502, 'COURSE_PACKAGE_TOO_MANY_REDIRECTS');
        let next: URL;
        try { next = new URL(location, current); } catch { throw remoteError(502, 'COURSE_PACKAGE_REDIRECT_REFUSED'); }
        current = next;
        continue;
      }
      const declared = Number(response.headers.get('content-length') ?? NaN);
      if (Number.isFinite(declared) && declared > limit) {
        await response.body?.cancel().catch(() => undefined);
        throw remoteError(413, 'PACKAGE_TOO_LARGE');
      }
      const chunks: Buffer[] = [];
      let total = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const { done, value } = await timed(reader.read(), remaining(readMs), controller);
            if (done) break;
            total += value.byteLength;
            if (total > limit) throw remoteError(413, 'PACKAGE_TOO_LARGE');
            chunks.push(Buffer.from(value));
          }
        } catch (error) {
          await reader.cancel().catch(() => undefined);
          if (error instanceof ApiError) throw error;
          throw remoteError(502, 'COURSE_PACKAGE_FETCH_FAILED');
        }
      }
      return { status: response.status, body: Buffer.concat(chunks), finalUrl: current.toString() };
    }
  } finally { controller.abort(); }
}

interface ReleaseAsset { name: string; size: number; browser_download_url: string }
async function githubJson(path: string, options: RemoteFetchOptions) {
  const response = await fetchBounded(`https://api.github.com${path}`, API_JSON_LIMIT, options, 'application/vnd.github+json');
  if (response.status === 403 || response.status === 429) throw remoteError(503, 'GITHUB_RATE_LIMITED');
  if (response.status === 404 || response.status === 401) return null;
  if (response.status !== 200) throw remoteError(502, 'GITHUB_UNAVAILABLE');
  try { return JSON.parse(response.body.toString('utf8')) as unknown; } catch { throw remoteError(502, 'GITHUB_UNAVAILABLE'); }
}

export interface ResolvedRemotePackage {
  bytes: Buffer;
  source: { kind: 'github'; owner: string; repo: string; tag: string; asset: string; checksumVerified: boolean };
}
/**
 * Resolves a GitHub URL to one `*.course.tgz` release asset and downloads it. Several matching
 * assets → 409 COURSE_PACKAGE_ASSET_CHOICE_REQUIRED with their names (choose with `asset`).
 * A sibling `<asset>.sha256` is verified when the release has one.
 */
export async function fetchGitHubPackage(input: string, chosenAsset: string | undefined, options: RemoteFetchOptions = {}): Promise<ResolvedRemotePackage> {
  const reference = parseGitHubUrl(input);
  const repoPath = `/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repo)}`;
  const release = await githubJson(`${repoPath}/releases/${reference.tag === null ? 'latest' : `tags/${encodeURIComponent(reference.tag)}`}`, options);
  if (release === null) {
    const repository = await githubJson(repoPath, options);
    if (repository === null) throw remoteError(404, 'GITHUB_REPOSITORY_NOT_PUBLIC_OR_MISSING');
    throw remoteError(404, 'GITHUB_RELEASE_NOT_FOUND');
  }
  const record = release as { tag_name?: unknown; assets?: unknown };
  if (typeof record.tag_name !== 'string' || !Array.isArray(record.assets)) throw remoteError(502, 'GITHUB_UNAVAILABLE');
  const assets = (record.assets as unknown[]).filter((asset): asset is ReleaseAsset => !!asset && typeof asset === 'object'
    && typeof (asset as ReleaseAsset).name === 'string' && typeof (asset as ReleaseAsset).browser_download_url === 'string' && Number.isSafeInteger((asset as ReleaseAsset).size));
  const packages = assets.filter(asset => asset.name.endsWith('.course.tgz'));
  const wanted = chosenAsset ?? reference.asset;
  let selected: ReleaseAsset | undefined;
  if (wanted !== null && wanted !== undefined) {
    selected = packages.find(asset => asset.name === wanted);
    if (!selected) throw remoteError(404, 'COURSE_PACKAGE_ASSET_NOT_FOUND', { assets: packages.map(asset => asset.name).slice(0, 50) });
  } else if (packages.length === 1) selected = packages[0];
  else if (!packages.length) throw remoteError(404, 'COURSE_PACKAGE_ASSET_NOT_FOUND', { assets: [] });
  else throw remoteError(409, 'COURSE_PACKAGE_ASSET_CHOICE_REQUIRED', { assets: packages.map(asset => asset.name).slice(0, 50) });
  // The download URL comes from GitHub's own answer; it must still be this repository's release asset on github.com.
  const expectedPrefix = `https://github.com/${reference.owner}/${reference.repo}/releases/download/`.toLowerCase();
  const assetUrl = (asset: ReleaseAsset) => {
    if (!asset.browser_download_url.toLowerCase().startsWith(expectedPrefix)) throw remoteError(502, 'COURSE_PACKAGE_REDIRECT_REFUSED');
    return asset.browser_download_url;
  };
  if (selected!.size > COURSE_PACKAGE_LIMITS.maxCompressedBytes) throw remoteError(413, 'PACKAGE_TOO_LARGE');
  const download = await fetchBounded(assetUrl(selected!), COURSE_PACKAGE_LIMITS.maxCompressedBytes, options, 'application/octet-stream');
  if (download.status !== 200) throw remoteError(502, 'COURSE_PACKAGE_FETCH_FAILED');
  const sibling = assets.find(asset => asset.name === `${selected!.name}.sha256`);
  let checksumVerified = false;
  if (sibling) {
    const checksum = await fetchBounded(assetUrl(sibling), CHECKSUM_LIMIT, options, 'text/plain');
    if (checksum.status !== 200) throw remoteError(502, 'COURSE_PACKAGE_FETCH_FAILED');
    verifyChecksumFile(checksum.body, selected!.name, download.body);
    checksumVerified = true;
  }
  return { bytes: download.body, source: { kind: 'github', owner: reference.owner, repo: reference.repo, tag: record.tag_name.slice(0, 200), asset: selected!.name, checksumVerified } };
}

/** `sha256sum` format: exactly one line "<64 hex>  <name>" (or " *<name>"); the name must be the package's base name. */
export function verifyChecksumFile(file: Buffer, assetName: string, bytes: Buffer) {
  const lines = file.toString('utf8').split(/\r?\n/).filter(line => line.trim());
  const match = lines.length === 1 ? /^([a-f0-9]{64}) [ *](\S+)$/.exec(lines[0]!) : null;
  if (!match || match[2] !== assetName) throw remoteError(422, 'PACKAGE_CHECKSUM_INVALID');
  const actual = sha256(bytes);
  if (match[1]!.toLowerCase() !== actual) throw remoteError(422, 'PACKAGE_CHECKSUM_MISMATCH');
}
