import { z } from 'zod';
import { counter, type ResearchOutput, type TokenUsage } from './contracts.js';
import { ensure, ProviderError } from './errors.js';
import { httpsUrl } from './google-response.js';
import { emptyTokens } from './http.js';
import { parse } from './validation.js';

/** Messages API `usage`. `input_tokens` excludes cache reads and writes; total input is the
 * sum of all three. `output_tokens` includes any thinking tokens. */
const usageSchema = z.object({
  input_tokens: counter, output_tokens: counter,
  cache_creation_input_tokens: counter.nullable().optional(),
  cache_read_input_tokens: counter.nullable().optional(),
  output_tokens_details: z.object({ thinking_tokens: counter.optional() }).nullable().optional(),
  server_tool_use: z.object({ web_search_requests: counter.optional(), web_fetch_requests: counter.optional() }).nullable().optional(),
});
/** Map to the portable counters: `input` is all input (cached reads/writes included, like
 * other adapters), `output` excludes thinking which is reported separately, `total` is
 * input plus all output. Missing counters stay unknown, never zero. */
export function anthropicTokens(data: Record<string, unknown>): TokenUsage {
  if (data.usage === undefined) return emptyTokens();
  const u = parse(usageSchema, data.usage, 'INVALID_RESPONSE');
  const read = u.cache_read_input_tokens ?? 0, write = u.cache_creation_input_tokens ?? 0;
  const thinking = u.output_tokens_details?.thinking_tokens ?? null;
  ensure(thinking === null || thinking <= u.output_tokens, 'INVALID_RESPONSE');
  const input = u.input_tokens + read + write, servers = u.server_tool_use;
  ensure(Number.isSafeInteger(input + u.output_tokens), 'INVALID_RESPONSE');
  return { input, output: thinking === null ? u.output_tokens : u.output_tokens - thinking, total: input + u.output_tokens,
    cachedInput: read, thoughts: thinking, toolInput: null, cacheWriteInput: write,
    serverToolRequests: servers ? (servers.web_search_requests ?? 0) + (servers.web_fetch_requests ?? 0) : 0 };
}

const citationSchema = z.object({ type: z.string(), url: z.string().optional(), title: z.string().nullable().optional() });
const blockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string(), citations: z.array(citationSchema).max(512).nullable().optional() }),
  z.object({ type: z.literal('thinking'), thinking: z.string() }),
  z.object({ type: z.literal('redacted_thinking'), data: z.string() }),
  z.object({ type: z.literal('server_tool_use'), name: z.string(), input: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal('web_search_tool_result'), content: z.unknown() }),
  z.object({ type: z.literal('tool_use') }),
]);
type Block = z.infer<typeof blockSchema>;
const messageSchema = z.object({
  type: z.literal('message'), role: z.literal('assistant'),
  content: z.array(z.unknown()).max(1024),
  stop_reason: z.string().nullable(),
});
export interface AnthropicMessage { content: Block[] }

/** Accept only a complete turn. A refusal is `BLOCKED`; a token cap, context overflow, pause or
 * any other stop is incomplete. Structured output that stopped early is never parsed. */
export function anthropicMessage(data: Record<string, unknown>, allowSearch: boolean): AnthropicMessage {
  const message = parse(messageSchema, data, 'INVALID_RESPONSE');
  if (message.stop_reason === 'refusal') throw new ProviderError('BLOCKED');
  ensure(message.stop_reason === 'end_turn', 'INCOMPLETE_OUTPUT');
  const content = message.content.map(raw => parse(blockSchema, raw, 'INVALID_RESPONSE'));
  ensure(content.every(block => block.type === 'text' || block.type === 'thinking' || block.type === 'redacted_thinking'
    || allowSearch && (block.type === 'web_search_tool_result' || block.type === 'server_tool_use' && block.name === 'web_search')), 'INVALID_RESPONSE');
  return { content };
}

export function anthropicText(message: AnthropicMessage): string {
  const answer = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
  ensure(answer.trim().length > 0, 'INVALID_RESPONSE');
  return answer;
}

/** Each cited text block is a cited part covering its whole UTF-8 byte range; web search
 * citations name only the source URL and title. Uncited text is never marked grounded. */
export function anthropicResearch(message: AnthropicMessage): ResearchOutput {
  const text = anthropicText(message);
  const sources: { uri: string; title: string }[] = [], citations: ResearchOutput['citations'] = [];
  const parts: ResearchOutput['parts'] = [], searchQueries: string[] = [];
  message.content.forEach((block, partIndex) => {
    if (block.type === 'server_tool_use') {
      const query = block.input.query;
      ensure(typeof query === 'string' && query.length <= 2000, 'INVALID_RESPONSE');
      if (searchQueries.length < 128) searchQueries.push(query);
    }
    if (block.type !== 'text') return;
    parts.push({ partIndex, text: block.text });
    const located = (block.citations ?? []).filter(citation => citation.type === 'web_search_result_location');
    if (!located.length) return;
    const sourceIndices = new Set<number>();
    for (const citation of located) {
      ensure(typeof citation.url === 'string', 'INVALID_RESPONSE');
      httpsUrl(citation.url);
      let index = sources.findIndex(source => source.uri === citation.url);
      if (index < 0) {
        ensure(sources.length < 512, 'INVALID_RESPONSE');
        index = sources.push({ uri: citation.url, title: (citation.title ?? '').slice(0, 512) }) - 1;
      }
      sourceIndices.add(index);
    }
    const endByte = Buffer.byteLength(block.text, 'utf8');
    if (endByte > 0) citations.push({ partIndex, startByte: 0, endByte, sourceIndices: [...sourceIndices] });
  });
  return { text, parts, sources, citations, searchQueries, searchSuggestionsHtml: null,
    grounding: sources.length > 0 && citations.length > 0 ? 'grounded' : 'not_grounded' };
}

const streamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message_start'), message: z.object({ type: z.literal('message'), role: z.literal('assistant'), usage: z.record(z.string(), z.unknown()).optional() }) }),
  z.object({ type: z.literal('content_block_start'), index: counter, content_block: z.object({ type: z.string().max(64) }) }),
  z.object({ type: z.literal('content_block_delta'), index: counter, delta: z.object({ type: z.string().max(64), text: z.string().optional() }) }),
  z.object({ type: z.literal('content_block_stop'), index: counter }),
  z.object({ type: z.literal('message_delta'), delta: z.object({ stop_reason: z.string().nullable().optional() }), usage: z.record(z.string(), z.unknown()).nullable().optional() }),
  z.object({ type: z.literal('message_stop') }),
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('error'), error: z.object({ type: z.string().max(128) }) }),
]);
const STREAM_EVENTS = new Set(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop', 'ping', 'error']);
/**
 * Reads Messages API stream events with the checks `anthropicMessage` applies to a whole turn:
 * only text and thinking blocks, stop_reason `end_turn` (a `refusal` is BLOCKED, any other stop
 * incomplete) and a final `message_stop`. Visible text deltas go to `onText`; thinking and
 * signature deltas are dropped. `message_start` carries the input usage and each `message_delta`
 * the cumulative usage, so later counters replace earlier ones. Unknown event types are ignored,
 * as the API's versioning policy asks; an `error` event ends the stream as an unknown outcome.
 */
export function anthropicStream(onText: (text: string) => void) {
  const blocks = new Map<number, string>();
  let started = false, stopped = false, stop: string | null | undefined, usage: Record<string, unknown> = {}, text = '';
  return {
    event(_name: string, data: Record<string, unknown>) {
      if (typeof data.type !== 'string' || !STREAM_EVENTS.has(data.type)) return;
      const event = parse(streamEventSchema, data, 'INVALID_RESPONSE');
      ensure(!stopped, 'INVALID_RESPONSE');
      switch (event.type) {
        case 'error':
          throw event.error.type === 'overloaded_error' ? new ProviderError('UPSTREAM_UNAVAILABLE', { status: 529, submission: 'unknown' })
            : new ProviderError(event.error.type === 'rate_limit_error' ? 'THROTTLED' : 'UPSTREAM_UNAVAILABLE', { submission: 'unknown' });
        case 'ping': return;
        case 'message_start': ensure(!started, 'INVALID_RESPONSE'); started = true; usage = { ...(event.message.usage ?? {}) }; return;
        case 'content_block_start':
          ensure(started && !blocks.has(event.index) && ['text', 'thinking', 'redacted_thinking'].includes(event.content_block.type), 'INVALID_RESPONSE');
          blocks.set(event.index, event.content_block.type); return;
        case 'content_block_delta': {
          const block = blocks.get(event.index);
          ensure(block !== undefined, 'INVALID_RESPONSE');
          if (event.delta.type === 'text_delta') {
            ensure(block === 'text' && typeof event.delta.text === 'string', 'INVALID_RESPONSE');
            if (event.delta.text) { text += event.delta.text; onText(event.delta.text); }
          } else ensure(block !== 'text' && ['thinking_delta', 'signature_delta'].includes(event.delta.type), 'INVALID_RESPONSE');
          return;
        }
        case 'content_block_stop': ensure(blocks.has(event.index), 'INVALID_RESPONSE'); return;
        case 'message_delta':
          ensure(started, 'INVALID_RESPONSE');
          if (event.delta.stop_reason !== undefined) stop = event.delta.stop_reason;
          if (event.usage) usage = { ...usage, ...event.usage };
          return;
        case 'message_stop': ensure(started, 'INVALID_RESPONSE'); stopped = true; return;
      }
    },
    tokens: () => started ? anthropicTokens({ usage }) : emptyTokens(),
    answer() {
      if (stop === 'refusal') throw new ProviderError('BLOCKED');
      ensure(stopped && stop === 'end_turn', 'INCOMPLETE_OUTPUT');
      ensure(text.trim().length > 0, 'INVALID_RESPONSE');
      return text;
    },
  };
}
