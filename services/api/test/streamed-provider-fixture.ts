/**
 * Scripted provider answers for tests that script whole (non-streamed) responses. Companion calls
 * now stream (docs/streamed-replies.md), so a scripted success is re-encoded in the documented
 * stream format of the endpoint that was called: Google streamGenerateContent?alt=sse (each
 * `data:` one GenerateContentResponse) and Anthropic Messages with stream:true (named events).
 * Errors keep their JSON bodies: the adapters read those before any stream starts.
 */
const sse = (frames: string[]) => frames.join('');
const frame = (data: unknown, event?: string) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;

/** A Google GenerateContentResponse as an SSE stream: each part in its own chunk (thought parts
 * stay thoughts), the visible text split in two, the finish reason and usage on the last chunk. */
export function googleStream(response: { candidates: { content: { parts: { text: string; thought?: boolean }[] }; finishReason?: string }[]; usageMetadata?: unknown }) {
  const candidate = response.candidates[0]!, parts: { text: string; thought?: boolean }[] = [];
  for (const part of candidate.content.parts) {
    if (part.thought) { parts.push(part); continue; }
    const cut = Math.ceil(part.text.length / 2);
    parts.push({ text: part.text.slice(0, cut) }, { text: part.text.slice(cut) });
  }
  if (!parts.length) parts.push({ text: '' });
  return sse(parts.map((part, index) => index < parts.length - 1
    ? frame({ candidates: [{ index: 0, content: { role: 'model', parts: [part] } }] })
    : frame({ candidates: [{ index: 0, finishReason: candidate.finishReason ?? 'STOP', content: { role: 'model', parts: [part] } }],
      ...(response.usageMetadata ? { usageMetadata: response.usageMetadata } : {}) })));
}
/** An Anthropic Message as its Messages API event stream. */
export function anthropicStream(message: { content: { type: string; text?: string }[]; stop_reason: string | null; usage: Record<string, unknown> }) {
  const { output_tokens: output, ...input } = message.usage;
  const frames = [frame({ type: 'message_start', message: { id: 'msg_stream', type: 'message', role: 'assistant', content: [], stop_reason: null, usage: { ...input, output_tokens: 1 } } }, 'message_start')];
  message.content.forEach((block, index) => {
    frames.push(frame({ type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { type: block.type } }, 'content_block_start'));
    if (block.type === 'text') frames.push(frame({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text ?? '' } }, 'content_block_delta'));
    frames.push(frame({ type: 'content_block_stop', index }, 'content_block_stop'));
  });
  frames.push(frame({ type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: output } }, 'message_delta'));
  frames.push(frame({ type: 'message_stop' }, 'message_stop'));
  return sse(frames);
}
/** Re-encodes a scripted success for a streaming request; anything else is returned unchanged. */
export async function streamedIfAsked(url: string, init: RequestInit | undefined, response: Response): Promise<Response> {
  if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'application/json') return response;
  const google = url.includes(':streamGenerateContent');
  const anthropic = !google && url.endsWith('/v1/messages') && typeof init?.body === 'string' && (JSON.parse(init.body) as { stream?: unknown }).stream === true;
  if (!google && !anthropic) return response;
  const body = await response.json();
  return new Response(google ? googleStream(body) : anthropicStream(body), { status: response.status, headers: { 'content-type': 'text/event-stream' } });
}
