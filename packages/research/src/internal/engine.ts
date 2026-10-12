import { z } from 'zod';
import { parse, policySchema, requestSchema, reviewSchema, validateAttribution, type AuthorizeResearch,
  type CatalogSource, type InspectionRequest, type ResearchPolicy, type ReviewedSource, type SourceAttribution, type SourceInspection, type SourceReviewInput } from '../contracts.js';
import { ResearchError, requireResearch } from '../errors.js';
import { approvedHost, publicHttpsUrl } from '../urls.js';
import { parseYouTubeId, youtubeDescriptor } from '../youtube.js';
import { decode, sha256 } from './extract.js';
import { extractBounded } from './extract-bounded.js';
import { abortReason, isRedirect, limits, requestPinned, resolvePublic, validateAddresses, type FetchHop, type FetchLimits, type Resolve } from './network.js';

export interface ResearchOptions { limits?: Partial<FetchLimits>; maxConcurrent?: number }
interface Dependencies { resolve: Resolve; request: FetchHop; now: () => number }
export const productionDependencies: Dependencies = { resolve: resolvePublic, request: requestPinned, now: Date.now };
const principalSchema = z.strictObject({ actorId: z.string().min(1).max(128), role: z.enum(['author', 'service']), policy: policySchema });
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function inspectionDigest(value: Omit<SourceInspection, 'inspectionId'>): string { return sha256(canonical(value)); }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function authorization<Credential>(authorize: AuthorizeResearch<Credential>, credential: Credential,
  input: InspectionRequest, operation: 'inspect' | 'review', signal: AbortSignal, now: number) {
  let principal: z.infer<typeof principalSchema>;
  try { principal = parse(principalSchema, await abortable(authorize(credential, { ...input, operation }), signal)); }
  catch (error) { if (signal.aborted) throw abortReason(signal); throw new ResearchError('NOT_AUTHORIZED'); }
  const policy = principal.policy;
  requireResearch(policy.id === input.policyId && (operation === 'inspect' || principal.role === 'author'), 'NOT_AUTHORIZED');
  requireResearch(Date.parse(policy.expiresAt) > now, 'POLICY_EXPIRED');
  requireResearch(policy.topics.some(topic => topic.id === input.topicId), 'TOPIC_NOT_APPROVED');
  requireResearch(new Set(policy.sources.map(source => source.id)).size === policy.sources.length && new Set(policy.topics.map(topic => topic.id)).size === policy.topics.length, 'INVALID_INPUT');
  policy.allowedHosts.forEach(approvedHost);
  const source = policy.sources.find(source => source.id === input.sourceId);
  requireResearch(source && source.topicIds.includes(input.topicId), 'SOURCE_NOT_APPROVED');
  // The request carries IDs only. Only the trusted authorizer supplies URLs and
  // optional author material; learner/provider free text is never put in a query.
  const url = source.kind === 'youtube' ? publicHttpsUrl(`https://www.youtube.com/watch?v=${parseYouTubeId(source.url)}`, true) : publicHttpsUrl(source.url);
  requireResearch(policy.allowedHosts.includes(url.hostname), 'DOMAIN_REJECTED');
  if (source.attribution) validateAttribution(source.attribution);
  requireResearch(source.kind === 'youtube' || (!source.transcript && !source.fallback), 'INVALID_INPUT');
  return { principal, source, policy, url };
}
async function fetchBounded(initial: URL, policy: ResearchPolicy, bounds: FetchLimits, signal: AbortSignal, deps: Dependencies, allowQuery: boolean) {
  let url = initial;
  const seen = new Set<string>(), hops: SourceInspection['provenance']['hops'] = [];
  for (let redirects = 0; ; redirects++) {
    requireResearch(Date.parse(policy.expiresAt) > deps.now(), 'POLICY_EXPIRED');
    url = publicHttpsUrl(url.href, allowQuery);
    requireResearch(policy.allowedHosts.includes(url.hostname), 'DOMAIN_REJECTED');
    requireResearch(!seen.has(url.href), 'REDIRECT_LOOP'); seen.add(url.href);
    const addresses = await abortable(deps.resolve(url.hostname, signal, bounds.dnsMs), signal);
    const pinned = validateAddresses(addresses);
    const result = await abortable(deps.request(url, pinned, bounds, signal), signal);
    requireResearch(result.address.address === pinned.address && result.address.family === pinned.family, 'PEER_MISMATCH');
    requireResearch(result.body.length <= bounds.maxBytes, 'BYTES_LIMIT');
    hops.push({ url: url.href, ...pinned, status: result.status });
    if (!isRedirect(result.status)) {
      requireResearch(result.status === 200, 'HTTP_STATUS');
      return { ...result, finalUrl: url.href, hops };
    }
    requireResearch(redirects < bounds.maxRedirects, 'REDIRECT_LIMIT');
    requireResearch(result.location && result.location.length <= 2048 && !/[\s\\\u0000-\u001f\u007f]/.test(result.location), 'URL_REJECTED');
    try { url = new URL(result.location, url); } catch { throw new ResearchError('URL_REJECTED'); }
  }
}
function metadata(body: Uint8Array): { title: string; attribution: SourceAttribution } {
  let raw: unknown;
  try { raw = JSON.parse(decode(body)); } catch { throw new ResearchError('UNSUPPORTED_CONTENT'); }
  const value = parse(z.object({ type: z.literal('video'), title: z.string().min(1).max(300), provider_name: z.string().min(1).max(200),
    provider_url: z.string().max(2048), author_name: z.string().max(300), author_url: z.string().max(2048) }), raw);
  return { title: value.title, attribution: validateAttribution({ trust: 'untrusted_provider_metadata', providerName: value.provider_name,
    providerUrl: value.provider_url, authorName: value.author_name, authorUrl: value.author_url }) };
}

/** Internal dependency injection is deliberately not a package export. Production
 * composition always uses the real public-IP validator and pinned TLS transport. */
export function createInspectionEngine<Credential>(authorize: AuthorizeResearch<Credential>, options: ResearchOptions = {}, deps: Dependencies = productionDependencies) {
  requireResearch(typeof authorize === 'function', 'INVALID_INPUT');
  const bounds = limits(options.limits), capacity = options.maxConcurrent ?? 4;
  requireResearch(Number.isSafeInteger(capacity) && capacity >= 1 && capacity <= 8, 'INVALID_INPUT');
  let active = 0;
  return { async inspect(credential: Credential, rawInput: unknown, externalSignal?: AbortSignal): Promise<SourceInspection> {
    const input = parse(requestSchema, rawInput);
    requireResearch(active < capacity, 'CAPACITY'); active++;
    const controller = new AbortController(), signal = controller.signal;
    const abort = () => controller.abort(new ResearchError('CANCELLED'));
    const timeout = setTimeout(() => controller.abort(new ResearchError('TIMEOUT')), bounds.totalMs);
    externalSignal?.addEventListener('abort', abort, { once: true });
    if (externalSignal?.aborted) abort();
    try {
      const { policy, source, url } = await authorization(authorize, credential, input, 'inspect', signal, deps.now());
      const attributions = source.attribution ? [source.attribution] : [];
      let title: string, text: string, truncated = false;
      let basis: SourceInspection['content']['basis'] = 'page';
      let provenance: SourceInspection['provenance'];
      let youtube: SourceInspection['youtube'];
      if (source.kind === 'web') {
        const fetched = await fetchBounded(url, policy, bounds, signal, deps, false);
        const readable = await extractBounded(fetched.body, fetched.mediaType, signal);
        ({ text, truncated } = readable); title = readable.title || url.hostname;
        if (readable.author) attributions.push({ trust: 'untrusted_provider_metadata', providerName: url.hostname, authorName: readable.author });
        provenance = { requestedUrl: url.href, finalUrl: fetched.finalUrl, fetchedAt: new Date(deps.now()).toISOString(), bodyDigest: sha256(fetched.body),
          bytes: fetched.body.length, mediaType: fetched.mediaType, hops: fetched.hops, extractionVersion: 'readable-text-v1', metadataAvailability: 'available' };
      } else {
        const videoId = parseYouTubeId(source.url);
        const metadataUrl = new URL('https://www.youtube.com/oembed');
        metadataUrl.searchParams.set('url', `https://www.youtube.com/watch?v=${videoId}`); metadataUrl.searchParams.set('format', 'json');
        let provider: SourceAttribution | undefined;
        title = 'YouTube video';
        try {
          const fetched = await fetchBounded(metadataUrl, policy, { ...bounds, maxBytes: Math.min(bounds.maxBytes, 131072) }, signal, deps, true);
          requireResearch(fetched.mediaType === 'application/json', 'UNSUPPORTED_CONTENT');
          const info = metadata(fetched.body); title = info.title; provider = info.attribution; attributions.push(provider);
          provenance = { requestedUrl: url.href, finalUrl: url.href, fetchedAt: new Date(deps.now()).toISOString(), bodyDigest: sha256(fetched.body), bytes: fetched.body.length,
            mediaType: fetched.mediaType, hops: fetched.hops, extractionVersion: 'readable-text-v1', metadataAvailability: 'available' };
        } catch (error) {
          // Network policy/TLS/limit violations never become a successful fallback.
          if (!(error instanceof ResearchError) || error.code !== 'HTTP_STATUS') throw error;
          provenance = { requestedUrl: url.href, finalUrl: url.href, fetchedAt: new Date(deps.now()).toISOString(), bodyDigest: null, bytes: 0,
            mediaType: null, hops: [], extractionVersion: 'readable-text-v1', metadataAvailability: 'unavailable', failureCode: error.code };
        }
        text = source.transcript?.text ?? source.fallback?.text ?? '';
        basis = source.transcript ? 'transcript' : source.fallback ? 'author_fallback' : 'metadata_only';
        youtube = youtubeDescriptor({ urlOrId: videoId, title, ...(provider ? { attribution: provider } : {}),
          ...(source.transcript ? { transcript: source.transcript } : {}), ...(source.fallback ? { fallback: source.fallback } : {}) });
      }
      if (signal.aborted) throw abortReason(signal);
      requireResearch(Date.parse(policy.expiresAt) > deps.now(), 'POLICY_EXPIRED');
      const result: Omit<SourceInspection, 'inspectionId'> = { formatVersion: 1, state: 'unreviewed', trust: 'untrusted_external_content',
        policy: { id: policy.id, revision: policy.revision, approvalId: policy.approvalId, approvedBy: policy.approvedBy },
        sourceId: source.id, topicId: input.topicId, kind: source.kind, title, content: { text, digest: sha256(text), truncated, basis },
        provenance, attributions, ...(youtube ? { youtube } : {}) };
      return freeze({ ...result, inspectionId: inspectionDigest(result) });
    } catch (error) { if (error instanceof ResearchError) throw error; throw new ResearchError('FETCH_FAILED'); }
    finally { clearTimeout(timeout); externalSignal?.removeEventListener('abort', abort); active--; }
  } };
}
export function verifyInspection(inspection: SourceInspection): void {
  requireResearch(inspection && inspection.formatVersion === 1 && inspection.state === 'unreviewed' && inspection.trust === 'untrusted_external_content' &&
    typeof inspection.content?.text === 'string' && inspection.content.text.length <= 64000 && inspection.content.digest === sha256(inspection.content.text) &&
    Array.isArray(inspection.attributions) && inspection.attributions.length <= 3 && Array.isArray(inspection.provenance?.hops) && inspection.provenance.hops.length <= 4, 'INSPECTION_CHANGED');
  inspection.attributions.forEach(validateAttribution);
  const { inspectionId, ...snapshot } = inspection;
  requireResearch(inspectionId === inspectionDigest(snapshot), 'INSPECTION_CHANGED');
}
/** No learner context, request headers, provider keys or arbitrary prompt fields. */
export function sourceReviewInput(inspection: SourceInspection, topic: { id: string; description: string }) {
  verifyInspection(inspection);
  requireResearch(topic.id === inspection.topicId && topic.description.length <= 1000, 'TOPIC_NOT_APPROVED');
  return freeze({ inspectionId: inspection.inspectionId, topic, title: inspection.title, url: inspection.provenance.finalUrl,
    trust: 'untrusted_external_content' as const, contentDigest: inspection.content.digest,
    excerpt: inspection.content.text.slice(0, 8000), excerptStart: 0, excerptTruncated: inspection.content.truncated || inspection.content.text.length > 8000,
    attributions: inspection.attributions, mayAuthorizeApproval: false as const });
}

/** loadInspection must read the immutable server-held record, not a browser/model
 * supplied document. Persist returned reviews append-only in parent composition. */
export function createReviewEngine<Credential>(authorize: AuthorizeResearch<Credential>, loadInspection: (id: string) => Promise<SourceInspection | undefined>) {
  return { async review(credential: Credential, rawInput: unknown): Promise<ReviewedSource> {
    const input = parse(reviewSchema, rawInput);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(new ResearchError('TIMEOUT')), 5000);
    try {
      const { principal, policy, url, source } = await authorization(authorize, credential, { policyId: input.policyId, sourceId: input.sourceId, topicId: input.topicId }, 'review', controller.signal, Date.now());
      const inspection = await abortable(loadInspection(input.inspectionId), controller.signal);
      requireResearch(inspection, 'INSPECTION_CHANGED'); verifyInspection(inspection);
      requireResearch(inspection.inspectionId === input.inspectionId && inspection.content.digest === input.contentDigest && inspection.policy.id === policy.id &&
        inspection.policy.revision === policy.revision && inspection.policy.approvalId === policy.approvalId && inspection.sourceId === input.sourceId &&
        inspection.topicId === input.topicId && inspection.provenance.requestedUrl === url.href && inspection.kind === source.kind, 'INSPECTION_CHANGED');
      requireResearch(input.evidence.every(evidence => inspection.content.text.slice(evidence.start, evidence.start + evidence.quote.length) === evidence.quote), 'REVIEW_EVIDENCE_REQUIRED');
      if (input.decision === 'approved') {
        requireResearch(inspection.content.basis !== 'metadata_only' && input.evidence.length > 0 && Object.values(input.suitability).every(Boolean) &&
          (!inspection.content.truncated || input.acknowledgesTruncation), 'REVIEW_EVIDENCE_REQUIRED');
        if (input.rights.use === 'excerpt') requireResearch(['owned', 'licensed', 'public_domain'].includes(input.rights.basis), 'RIGHTS_REQUIRED');
        if (input.rights.use === 'embed') requireResearch(inspection.youtube && inspection.provenance.metadataAvailability === 'available' &&
          ['provider_embed', 'owned', 'licensed', 'public_domain'].includes(input.rights.basis), 'RIGHTS_REQUIRED');
      }
      const result: Omit<ReviewedSource, 'reviewId'> = { formatVersion: 1, sourceId: input.sourceId, topicId: input.topicId, inspectionId: inspection.inspectionId,
        status: input.decision, title: inspection.title, url: inspection.provenance.finalUrl, contentDigest: inspection.content.digest, bodyDigest: inspection.provenance.bodyDigest,
        reviewedBy: principal.actorId, reviewedAt: new Date().toISOString(), policy: inspection.policy, rationale: input.rationale, evidence: input.evidence,
        suitability: input.suitability, rights: input.rights, attributions: inspection.attributions,
        display: { title: inspection.title, url: inspection.provenance.finalUrl, excerpts: input.decision === 'approved' && input.rights.use === 'excerpt' ? input.evidence.map(evidence => evidence.quote) : [],
          ...(input.decision === 'approved' && input.rights.use === 'embed' && inspection.youtube ? { youtube: inspection.youtube } : {}) },
        qualification: 'author_content_review_not_truth_certification' };
      return freeze({ ...result, reviewId: sha256(canonical(result)) });
    } catch (error) { if (error instanceof ResearchError) throw error; throw new ResearchError('INSPECTION_CHANGED'); }
    finally { clearTimeout(timer); }
  } };
}
