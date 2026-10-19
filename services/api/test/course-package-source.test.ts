import { describe, expect, it } from 'vitest';
import { ALLOWED_HOSTS, fetchBounded, fetchGitHubPackage, parseGitHubUrl, remoteFetchMode, verifyChecksumFile, type PackageFetcher } from '../src/course-package-source.js';
import { sha256 } from '../src/course-package.js';

type Route = (url: URL, init: Parameters<PackageFetcher>[1]) => Response | Promise<Response>;
/** A fake network: every request is recorded; unknown URLs are a test failure (404). */
function fakeNetwork(routes: Record<string, Route>) {
  const calls: { url: string; init: Parameters<PackageFetcher>[1] }[] = [];
  const fetcher: PackageFetcher = async (url, init) => {
    calls.push({ url, init });
    const route = routes[url];
    return route ? route(new URL(url), init) : new Response('not found', { status: 404 });
  };
  return { fetcher, calls };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
const bytes = Buffer.from('synthetic package bytes');
const asset = (name: string, tag = 'v1.0.0', repo = 'example/course') => ({ name, size: bytes.length, browser_download_url: `https://github.com/${repo}/releases/download/${tag}/${name}` });
const api = 'https://api.github.com/repos/example/course';

describe('GitHub course-package source', () => {
  it('parses only the supported GitHub URL forms, before any network access', () => {
    expect(parseGitHubUrl('https://github.com/example/course')).toEqual({ owner: 'example', repo: 'course', tag: null, asset: null });
    expect(parseGitHubUrl('https://github.com/example/course.git')).toMatchObject({ repo: 'course' });
    expect(parseGitHubUrl('https://github.com/example/course/releases/latest')).toMatchObject({ tag: null });
    expect(parseGitHubUrl('https://github.com/example/course/releases/tag/v1.2.0')).toMatchObject({ tag: 'v1.2.0', asset: null });
    expect(parseGitHubUrl('https://github.com/example/course/releases/download/v1.2.0/course-1.2.0.course.tgz')).toMatchObject({ tag: 'v1.2.0', asset: 'course-1.2.0.course.tgz' });
    for (const url of ['http://github.com/example/course', 'https://gitlab.com/example/course', 'https://github.com.evil.example/example/course', ['https://user', 'pw@github.com/example/course'].join(':'),
      'https://github.com/example/course?x=1', 'https://github.com/example/course/tree/main', 'https://github.com:8443/example/course', 'https://api.github.com/repos/example/course',
      'https://github.com/example/course/releases/download/v1/../../x', 'file:///etc/passwd', 'not a url'])
      expect(() => parseGitHubUrl(url), url).toThrow('COURSE_PACKAGE_URL_UNSUPPORTED');
  });
  it('resolves the latest release, downloads through an allowlisted redirect and verifies the sibling .sha256', async () => {
    const net = fakeNetwork({
      [`${api}/releases/latest`]: () => json({ tag_name: 'v1.0.0', assets: [asset('course-1.0.0.course.tgz'), asset('course-1.0.0.course.tgz.sha256'), asset('notes.txt')] }),
      'https://github.com/example/course/releases/download/v1.0.0/course-1.0.0.course.tgz': () => redirect('https://release-assets.githubusercontent.com/github-production-release-asset/1?sig=x'),
      'https://release-assets.githubusercontent.com/github-production-release-asset/1?sig=x': () => new Response(bytes),
      'https://github.com/example/course/releases/download/v1.0.0/course-1.0.0.course.tgz.sha256': () => new Response(`${sha256(bytes)}  course-1.0.0.course.tgz\n`),
    });
    const resolved = await fetchGitHubPackage('https://github.com/example/course', undefined, { fetcher: net.fetcher });
    expect(resolved.bytes.equals(bytes)).toBe(true);
    expect(resolved.source).toEqual({ kind: 'github', owner: 'example', repo: 'course', tag: 'v1.0.0', asset: 'course-1.0.0.course.tgz', checksumVerified: true });
    for (const call of net.calls) {
      expect(ALLOWED_HOSTS).toContain(new URL(call.url).hostname);
      expect(call.init).toMatchObject({ redirect: 'manual', credentials: 'omit' });
      expect(Object.keys(call.init.headers).map(h => h.toLowerCase())).not.toContain('cookie');
      expect(Object.keys(call.init.headers).map(h => h.toLowerCase())).not.toContain('authorization');
    }
  });
  it('resolves a tag and a direct download URL through the releases API', async () => {
    const net = fakeNetwork({
      [`${api}/releases/tags/v2.0.0`]: () => json({ tag_name: 'v2.0.0', assets: [asset('a.course.tgz', 'v2.0.0'), asset('b.course.tgz', 'v2.0.0')] }),
      'https://github.com/example/course/releases/download/v2.0.0/b.course.tgz': () => new Response(bytes),
    });
    const resolved = await fetchGitHubPackage('https://github.com/example/course/releases/download/v2.0.0/b.course.tgz', undefined, { fetcher: net.fetcher });
    expect(resolved.source).toMatchObject({ tag: 'v2.0.0', asset: 'b.course.tgz', checksumVerified: false });
  });
  it('returns the asset list when several packages are attached, and accepts a choice', async () => {
    const routes = {
      [`${api}/releases/tags/v2.0.0`]: () => json({ tag_name: 'v2.0.0', assets: [asset('a.course.tgz', 'v2.0.0'), asset('b.course.tgz', 'v2.0.0')] }),
      'https://github.com/example/course/releases/download/v2.0.0/a.course.tgz': () => new Response(bytes),
    };
    await expect(fetchGitHubPackage('https://github.com/example/course/releases/tag/v2.0.0', undefined, { fetcher: fakeNetwork(routes).fetcher }))
      .rejects.toMatchObject({ statusCode: 409, code: 'COURSE_PACKAGE_ASSET_CHOICE_REQUIRED', details: { assets: ['a.course.tgz', 'b.course.tgz'] } });
    await expect(fetchGitHubPackage('https://github.com/example/course/releases/tag/v2.0.0', 'a.course.tgz', { fetcher: fakeNetwork(routes).fetcher })).resolves.toMatchObject({ source: { asset: 'a.course.tgz' } });
    await expect(fetchGitHubPackage('https://github.com/example/course/releases/tag/v2.0.0', 'zzz.course.tgz', { fetcher: fakeNetwork(routes).fetcher })).rejects.toMatchObject({ code: 'COURSE_PACKAGE_ASSET_NOT_FOUND' });
  });
  it('reports a private or missing repository, and a missing release, distinctly', async () => {
    await expect(fetchGitHubPackage('https://github.com/example/course', undefined, { fetcher: fakeNetwork({}).fetcher })).rejects.toMatchObject({ statusCode: 404, code: 'GITHUB_REPOSITORY_NOT_PUBLIC_OR_MISSING' });
    await expect(fetchGitHubPackage('https://github.com/example/course', undefined, { fetcher: fakeNetwork({ [api]: () => json({ id: 1 }) }).fetcher })).rejects.toMatchObject({ code: 'GITHUB_RELEASE_NOT_FOUND' });
    await expect(fetchGitHubPackage('https://github.com/example/course', undefined, { fetcher: fakeNetwork({ [`${api}/releases/latest`]: () => json({ message: 'rate' }, 403) }).fetcher })).rejects.toMatchObject({ code: 'GITHUB_RATE_LIMITED' });
    await expect(fetchGitHubPackage('https://github.com/example/course', undefined, { fetcher: fakeNetwork({ [`${api}/releases/latest`]: () => json({ tag_name: 'v1', assets: [asset('notes.txt', 'v1')] }) }).fetcher }))
      .rejects.toMatchObject({ code: 'COURSE_PACKAGE_ASSET_NOT_FOUND' });
  });
  it('refuses a redirect to a host outside the allowlist without contacting it', async () => {
    const net = fakeNetwork({
      [`${api}/releases/latest`]: () => json({ tag_name: 'v1.0.0', assets: [asset('c.course.tgz')] }),
      'https://github.com/example/course/releases/download/v1.0.0/c.course.tgz': () => redirect('https://attacker.example/c.course.tgz'),
    });
    await expect(fetchGitHubPackage('https://github.com/example/course', undefined, { fetcher: net.fetcher })).rejects.toMatchObject({ code: 'COURSE_PACKAGE_REDIRECT_REFUSED' });
    expect(net.calls.map(call => new URL(call.url).hostname)).not.toContain('attacker.example');
    // http downgrade and IP literals are refused too.
    for (const location of ['http://objects.githubusercontent.com/x', 'https://127.0.0.1/x', 'https://objects.githubusercontent.com:444/x']) {
      const hop = fakeNetwork({ 'https://github.com/a/b': () => redirect(location) });
      await expect(fetchBounded('https://github.com/a/b', 100, { fetcher: hop.fetcher }, '*/*')).rejects.toMatchObject({ code: 'COURSE_PACKAGE_REDIRECT_REFUSED' });
      expect(hop.calls).toHaveLength(1);
    }
  });
  it('refuses a download URL that is not this repository\'s release asset', async () => {
    const net = fakeNetwork({ [`${api}/releases/latest`]: () => json({ tag_name: 'v1.0.0', assets: [{ ...asset('c.course.tgz'), browser_download_url: 'https://github.com/other/repo/releases/download/v1.0.0/c.course.tgz' }] }) });
    await expect(fetchGitHubPackage('https://github.com/example/course', undefined, { fetcher: net.fetcher })).rejects.toMatchObject({ code: 'COURSE_PACKAGE_REDIRECT_REFUSED' });
    expect(net.calls).toHaveLength(1);
  });
  it('stops after five redirects', async () => {
    const routes: Record<string, Route> = {};
    for (let i = 0; i < 10; i++) routes[`https://github.com/loop/${i}`] = () => redirect(`https://github.com/loop/${i + 1}`);
    const net = fakeNetwork(routes);
    await expect(fetchBounded('https://github.com/loop/0', 100, { fetcher: net.fetcher }, '*/*')).rejects.toMatchObject({ code: 'COURSE_PACKAGE_TOO_MANY_REDIRECTS' });
    expect(net.calls).toHaveLength(6);
  });
  it('aborts an oversize stream and refuses an oversize declared length', async () => {
    let pulled = 0, cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulled++; controller.enqueue(new Uint8Array(1024)); }, cancel() { cancelled = true; } });
    await expect(fetchBounded('https://github.com/big', 4096, { fetcher: fakeNetwork({ 'https://github.com/big': () => new Response(stream) }).fetcher }, '*/*')).rejects.toMatchObject({ statusCode: 413, code: 'PACKAGE_TOO_LARGE' });
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
    await expect(fetchBounded('https://github.com/big', 4096, { fetcher: fakeNetwork({ 'https://github.com/big': () => new Response('x', { headers: { 'content-length': '999999' } }) }).fetcher }, '*/*'))
      .rejects.toMatchObject({ code: 'PACKAGE_TOO_LARGE' });
    const oversize = fakeNetwork({ [`${api}/releases/latest`]: () => json({ tag_name: 'v1', assets: [{ ...asset('c.course.tgz', 'v1'), size: 65 * 1024 * 1024 }] }) });
    await expect(fetchGitHubPackage('https://github.com/example/course', undefined, { fetcher: oversize.fetcher })).rejects.toMatchObject({ code: 'PACKAGE_TOO_LARGE' });
  });
  it('times out a hop that never answers and a body that stalls', async () => {
    const hang: PackageFetcher = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    await expect(fetchBounded('https://github.com/slow', 100, { fetcher: hang, connectTimeoutMs: 20 }, '*/*')).rejects.toMatchObject({ statusCode: 504, code: 'COURSE_PACKAGE_FETCH_TIMEOUT' });
    const stall = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(1)); } });
    await expect(fetchBounded('https://github.com/slow', 100, { fetcher: async () => new Response(stall), readTimeoutMs: 20 }, '*/*')).rejects.toMatchObject({ code: 'COURSE_PACKAGE_FETCH_TIMEOUT' });
  });
  it('verifies sha256sum files strictly', async () => {
    const digest = sha256(bytes);
    expect(() => verifyChecksumFile(Buffer.from(`${digest}  a.course.tgz\n`), 'a.course.tgz', bytes)).not.toThrow();
    expect(() => verifyChecksumFile(Buffer.from(`${digest} *a.course.tgz`), 'a.course.tgz', bytes)).not.toThrow();
    expect(() => verifyChecksumFile(Buffer.from(`${'0'.repeat(64)}  a.course.tgz`), 'a.course.tgz', bytes)).toThrow('PACKAGE_CHECKSUM_MISMATCH');
    for (const file of [`${digest}  other.course.tgz`, digest, `${digest.toUpperCase()}  a.course.tgz`, 'not a checksum', `${digest}  a.course.tgz\n${digest}  a.course.tgz`, ''])
      expect(() => verifyChecksumFile(Buffer.from(file), 'a.course.tgz', bytes), file).toThrow('PACKAGE_CHECKSUM_INVALID');
    const net = fakeNetwork({
      [`${api}/releases/latest`]: () => json({ tag_name: 'v1.0.0', assets: [asset('c.course.tgz'), asset('c.course.tgz.sha256')] }),
      'https://github.com/example/course/releases/download/v1.0.0/c.course.tgz': () => new Response(bytes),
      'https://github.com/example/course/releases/download/v1.0.0/c.course.tgz.sha256': () => new Response(`${'f'.repeat(64)}  c.course.tgz`),
    });
    await expect(fetchGitHubPackage('https://github.com/example/course', undefined, { fetcher: net.fetcher })).rejects.toMatchObject({ code: 'PACKAGE_CHECKSUM_MISMATCH' });
  });
  it('parses the operator switch', () => {
    expect(remoteFetchMode(undefined)).toBe('github');
    expect(remoteFetchMode('off')).toBe('off');
    expect(() => remoteFetchMode('any')).toThrow();
  });
});
