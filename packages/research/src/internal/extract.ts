import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { createHash } from 'node:crypto';
import { ResearchError, requireResearch } from '../errors.js';

export const sha256 = (input: string | Uint8Array) => createHash('sha256').update(input).digest('hex');
export function decode(body: Uint8Array): string {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); }
  catch { throw new ResearchError('INVALID_TEXT'); }
  requireResearch(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text), 'INVALID_TEXT');
  return text;
}
type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
const isElement = (node: Node): node is Element => 'tagName' in node;
const attrs = (node: Element) => Object.fromEntries(node.attrs.map(attr => [attr.name, attr.value]));
const blocked = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'svg', 'canvas', 'video', 'audio', 'nav', 'footer', 'header', 'aside', 'form', 'input', 'button', 'select', 'textarea', 'head']);
function hidden(node: Element): boolean {
  const a = attrs(node);
  return 'hidden' in a || 'inert' in a || a['aria-hidden'] === 'true' || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(a.style ?? '');
}
const clean = (text: string) => text.replace(/\s+/g, ' ').trim();
/** Inert HTML5 parsing; no DOM Window, script execution, layout, subresource
 * requests, canonical-link following or provider HTML returned to the caller. */
export function extractReadable(body: Uint8Array, mediaType: string) {
  const raw = decode(body);
  if (mediaType === 'text/plain') {
    const normalized = raw.replace(/\r\n?/g, '\n').trim();
    requireResearch(normalized.length >= 20, 'NO_READABLE_CONTENT');
    return { title: '', text: normalized.slice(0, 64000), truncated: normalized.length > 64000, author: '' };
  }
  requireResearch(mediaType === 'text/html', 'UNSUPPORTED_CONTENT');
  requireResearch((raw.match(/</g)?.length ?? 0) <= 30000, 'HTML_LIMIT');
  const document = parse(raw, { scriptingEnabled: false });
  let main: Node | undefined, article: Node | undefined, bodyNode: Node | undefined;
  let title = '', author = '', visited = 0;
  const inspect: { node: Node; depth: number; suppressed: boolean }[] = [{ node: document, depth: 0, suppressed: false }];
  while (inspect.length) {
    const { node, depth, suppressed } = inspect.pop()!;
    requireResearch(++visited <= 30000 && depth <= 256, 'HTML_LIMIT');
    const excluded = suppressed || (isElement(node) && hidden(node));
    if (isElement(node) && !excluded) {
      if (node.tagName === 'main' && !main) main = node;
      if (node.tagName === 'article' && !article) article = node;
      if (node.tagName === 'body') bodyNode = node;
      if (node.tagName === 'title' && !title) title = clean(node.childNodes.filter(row => row.nodeName === '#text').map(row => (row as DefaultTreeAdapterMap['textNode']).value).join(' ')).slice(0, 300);
      if (node.tagName === 'meta' && attrs(node).name?.toLowerCase() === 'author') author = clean(attrs(node).content ?? '').slice(0, 300);
    }
    if ('childNodes' in node && !(isElement(node) && ['script', 'template', 'svg'].includes(node.tagName))) {
      for (let i = node.childNodes.length - 1; i >= 0; i--) inspect.push({ node: node.childNodes[i]!, depth: depth + 1, suppressed: excluded });
    }
  }
  const parts: string[] = [];
  const stack: Node[] = [main ?? article ?? bodyNode ?? document];
  let length = 0, truncated = false;
  while (stack.length) {
    const node = stack.pop()!;
    if (isElement(node) && (blocked.has(node.tagName) || hidden(node))) continue;
    if (node.nodeName === '#text') {
      const part = clean((node as DefaultTreeAdapterMap['textNode']).value);
      if (part) { parts.push(part); length += part.length + 1; }
      if (length > 64000) { truncated = true; break; }
    } else if ('childNodes' in node) for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]!);
  }
  const text = parts.join('\n').slice(0, 64000);
  requireResearch(text.length >= 20, 'NO_READABLE_CONTENT');
  return { title, text, truncated, author };
}
