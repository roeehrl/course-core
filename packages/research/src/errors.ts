export type ResearchErrorCode = 'INVALID_INPUT' | 'NOT_AUTHORIZED' | 'POLICY_EXPIRED' | 'TOPIC_NOT_APPROVED' |
  'SOURCE_NOT_APPROVED' | 'URL_REJECTED' | 'DOMAIN_REJECTED' | 'ADDRESS_REJECTED' | 'DNS_FAILED' |
  'DNS_LIMIT' | 'TIMEOUT' | 'CANCELLED' | 'FETCH_FAILED' | 'TLS_FAILED' | 'PEER_MISMATCH' |
  'HEADERS_LIMIT' | 'BYTES_LIMIT' | 'UNSUPPORTED_ENCODING' | 'UNSUPPORTED_CONTENT' | 'INVALID_TEXT' |
  'HTTP_STATUS' | 'REDIRECT_LIMIT' | 'REDIRECT_LOOP' | 'HTML_LIMIT' | 'NO_READABLE_CONTENT' |
  'REVIEW_EVIDENCE_REQUIRED' | 'INSPECTION_CHANGED' | 'RIGHTS_REQUIRED' | 'CAPACITY';
/** Codes deliberately omit upstream error strings, URL paths, headers and body data. */
export class ResearchError extends Error {
  constructor(readonly code: ResearchErrorCode) { super(code); this.name = 'ResearchError'; }
}
export function requireResearch(value: unknown, code: ResearchErrorCode): asserts value {
  if (!value) throw new ResearchError(code);
}
