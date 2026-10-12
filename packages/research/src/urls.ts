import { ResearchError, requireResearch } from './errors.js';

/** Deliberately excludes IP literals, IDNs, userinfo, alternate ports, fragments,
 * percent-encoded authorities and ambiguous WHATWG URL normalizations. */
export function publicHttpsUrl(value: string, allowQuery = false): URL {
  requireResearch(typeof value === 'string' && value.length <= 2048 && /^https:\/\//.test(value) &&
    !/[\s\\\u0000-\u001f\u007f-\u009f]/.test(value), 'URL_REJECTED');
  const authority = value.slice(8).split(/[/?#]/, 1)[0]!;
  requireResearch(/^[a-zA-Z0-9.-]+(?::443)?$/.test(authority), 'URL_REJECTED');
  let url: URL;
  try { url = new URL(value); } catch { throw new ResearchError('URL_REJECTED'); }
  const hostname = url.hostname;
  requireResearch(url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash &&
    (allowQuery || !url.search) && hostname.length <= 253 && hostname.includes('.') &&
    hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) && !label.startsWith('xn--')) &&
    /[a-z]/.test(hostname.split('.').at(-1)!) &&
    !['localhost', 'local', 'internal', 'home', 'test', 'invalid', 'onion'].some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`)), 'URL_REJECTED');
  requireResearch(authority.toLowerCase().replace(/:443$/, '') === hostname, 'URL_REJECTED');
  return url;
}
export function approvedHost(value: string): string {
  requireResearch(typeof value === 'string' && value === value.toLowerCase() && publicHttpsUrl(`https://${value}/`).hostname === value, 'DOMAIN_REJECTED');
  return value;
}
export function safeDisplayUrl(value: string): string { return publicHttpsUrl(value, true).href; }
