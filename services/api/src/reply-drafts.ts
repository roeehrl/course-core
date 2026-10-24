/**
 * Streamed companion replies (requirement T01; docs/streamed-replies.md).
 *
 * While the provider gateway's companion call is answering, its text is relayed to the learner's
 * open event streams as a *draft*: shown as it arrives, clearly marked as not yet checked, and
 * replaced by the stored reply once Core has verified and applied it. Nothing here is stored:
 * a draft lives only in this process's memory, for a bounded time, and is never exported.
 *
 * Release rule. Text is released at safe boundaries only, never per provider chunk: after a
 * sentence or line end, or at a word boundary once enough text is waiting (never inside a word,
 * a surrogate pair or a run of whitespace). Each release is checked against the same bound the
 * stored reply must meet (COMPANION_REPLY_MAX_CHARACTERS): a draft that grows past it is withdrawn
 * at once instead of waiting for the final check to refuse it. Checks that can only be made on the
 * whole answer (the provider's finish and safety verdicts, Core's verifier) cannot be made
 * incrementally; when one of them refuses the answer, the draft is withdrawn and the learner sees
 * that the reply could not be shown. The refused text is never stored or exported.
 */

/** The longest reply Core stores (supervisor-bridge.ts artifact rule and companion-verifier.ts). */
export const COMPANION_REPLY_MAX_CHARACTERS = 16_000;
/** Release at a word boundary once this much text is waiting without a sentence end. */
const WORD_RELEASE_CHARACTERS = 48;
/** Hold limit: with no boundary at all (one very long token), release anyway at a code point. */
const HARD_RELEASE_CHARACTERS = 400;
const MAX_DRAFTS = 500;
const ENDED_TTL_MS = 120_000;
const ACTIVE_TTL_MS = 600_000;
const MAX_LISTENERS_PER_ENROLLMENT = 16;

export type DraftState = 'streaming' | 'complete' | 'withdrawn' | 'cancelled';
/** Why a draft was withdrawn; codes only, translated by the app. */
export type DraftReason = 'output_too_large' | 'provider_refused' | 'provider_failed' | 'output_refused';
/** One frame for the learner's stream: `text` replaces whatever the client holds from `offset` on. */
export interface DraftFrame { jobId: string; messageId: string; offset: number; text: string; state: DraftState; reason?: DraftReason }
interface Draft {
  enrollmentId: string; jobId: string; messageId: string;
  released: string; pending: string; state: DraftState; reason?: DraftReason;
  openedAt: number; endedAt: number | null;
}
type Listener = (frame: DraftFrame) => void;

const SENTENCE_END = /[.!?…:;׃؟。！？]["'”’)\]]*\s+|\n+/g;
/** The longest prefix of `pending` that ends at a safe boundary (0 when none). */
export function releasable(pending: string): number {
  let cut = 0;
  for (const match of pending.matchAll(SENTENCE_END)) cut = match.index + match[0].length;
  if (cut > 0) return cut;
  if (pending.length >= WORD_RELEASE_CHARACTERS) {
    const space = pending.search(/\s+\S*$/);
    if (space > 0) return space + (pending.slice(space).match(/^\s+/)?.[0].length ?? 0);
  }
  if (pending.length >= HARD_RELEASE_CHARACTERS) {
    // Never split a surrogate pair.
    const code = pending.charCodeAt(HARD_RELEASE_CHARACTERS - 1);
    return code >= 0xd800 && code <= 0xdbff ? HARD_RELEASE_CHARACTERS - 1 : HARD_RELEASE_CHARACTERS;
  }
  return 0;
}

export class ReplyDrafts {
  private readonly drafts = new Map<string, Draft>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly forgotten = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}

  private sweep() {
    const now = this.now();
    for (const [id, draft] of this.drafts)
      if ((draft.endedAt !== null && now - draft.endedAt > ENDED_TTL_MS) || now - draft.openedAt > ACTIVE_TTL_MS) this.drafts.delete(id);
    for (const [id, at] of this.forgotten) if (now - at > ACTIVE_TTL_MS) this.forgotten.delete(id);
  }
  private emit(draft: Draft, frame: DraftFrame) {
    for (const listener of this.listeners.get(draft.enrollmentId) ?? []) try { listener(frame); } catch { /* one stream's problem */ }
  }
  private end(draft: Draft, state: Exclude<DraftState, 'streaming'>, reason?: DraftReason) {
    if (draft.state !== 'streaming') return;
    draft.state = state; draft.endedAt = this.now();
    if (reason) draft.reason = reason;
    // A withdrawn or stopped draft keeps no text: a reconnecting client gets only the notice.
    if (state !== 'complete') { draft.released = ''; draft.pending = ''; }
    this.emit(draft, { jobId: draft.jobId, messageId: draft.messageId, offset: 0, text: draft.released, state, ...(reason ? { reason } : {}) });
  }
  private release(draft: Draft, all: boolean) {
    const cut = all ? draft.pending.length : releasable(draft.pending);
    if (!cut) return;
    const segment = draft.pending.slice(0, cut);
    if (draft.released.length + segment.length > COMPANION_REPLY_MAX_CHARACTERS) { this.end(draft, 'withdrawn', 'output_too_large'); return; }
    // Leading whitespace alone is not worth a frame; it goes out with the next text.
    if (!draft.released && !segment.trim()) { if (all) draft.pending = ''; return; }
    draft.pending = draft.pending.slice(cut);
    const offset = draft.released.length;
    draft.released += segment;
    this.emit(draft, { jobId: draft.jobId, messageId: draft.messageId, offset, text: segment, state: 'streaming' });
  }

  /**
   * Opens the draft of one companion job. Returns a writer the gateway feeds with provider text;
   * null when the enrollment was erased meanwhile or the process already holds its bound of
   * drafts (the learner then sees the verified reply only, as before streaming).
   *
   * Opening is the dispatch signal: the gateway opens the draft right after it recorded that the
   * call may be sent, so an empty `streaming` frame goes out at once. The learner's app then shows
   * the question as sent (a reply is being written) and offers Stop, without waiting for a read of
   * the conversation or for the first sentence.
   */
  open(key: { enrollmentId: string; jobId: string; messageId: string }) {
    this.sweep();
    if (this.forgotten.has(key.enrollmentId) || this.drafts.size >= MAX_DRAFTS) return null;
    const draft: Draft = { ...key, released: '', pending: '', state: 'streaming', openedAt: this.now(), endedAt: null };
    this.drafts.set(key.jobId, draft);
    this.emit(draft, { jobId: draft.jobId, messageId: draft.messageId, offset: 0, text: '', state: 'streaming' });
    return {
      /** Provider text as it arrives. Ignored once the draft ended (stopped, withdrawn, erased). */
      push: (text: string) => {
        if (draft.state !== 'streaming' || this.drafts.get(draft.jobId) !== draft) return;
        // The pending bound: more waiting text than a stored reply may hold is already refused.
        if (draft.released.length + draft.pending.length + text.length > COMPANION_REPLY_MAX_CHARACTERS + HARD_RELEASE_CHARACTERS) { this.end(draft, 'withdrawn', 'output_too_large'); return; }
        draft.pending += text;
        this.release(draft, false);
      },
      /** The provider finished and Core's own output rules accepted the answer: release the rest. */
      complete: () => { if (draft.state === 'streaming') { this.release(draft, true); this.end(draft, 'complete'); } },
      /** The answer was refused or failed before it could be kept. */
      withdraw: (reason: DraftReason) => this.end(draft, 'withdrawn', reason),
      get ended() { return draft.state !== 'streaming'; },
    };
  }
  /** The learner stopped the reply. True when a draft was streaming. */
  cancel(enrollmentId: string, jobId: string) {
    const draft = this.drafts.get(jobId);
    if (!draft || draft.enrollmentId !== enrollmentId || draft.state !== 'streaming') return false;
    this.end(draft, 'cancelled');
    return true;
  }
  /** Data erasure: every draft of the enrollment is dropped and no new one may open for a while. */
  forget(enrollmentId: string) {
    this.forgotten.set(enrollmentId, this.now());
    for (const [id, draft] of this.drafts) if (draft.enrollmentId === enrollmentId) { draft.state = 'cancelled'; this.drafts.delete(id); }
    this.listeners.delete(enrollmentId);
  }
  /** Frames that restore every current draft of an enrollment (a reconnecting stream). */
  current(enrollmentId: string): DraftFrame[] {
    this.sweep();
    return [...this.drafts.values()].filter(d => d.enrollmentId === enrollmentId)
      .map(d => ({ jobId: d.jobId, messageId: d.messageId, offset: 0, text: d.released, state: d.state, ...(d.reason ? { reason: d.reason } : {}) }));
  }
  /** Follows the enrollment's drafts; null when it already has its bound of followers. */
  subscribe(enrollmentId: string, listener: Listener): (() => void) | null {
    const set = this.listeners.get(enrollmentId) ?? new Set<Listener>();
    if (set.size >= MAX_LISTENERS_PER_ENROLLMENT) return null;
    set.add(listener); this.listeners.set(enrollmentId, set);
    return () => { set.delete(listener); if (!set.size && this.listeners.get(enrollmentId) === set) this.listeners.delete(enrollmentId); };
  }
  /** Drafts held now (for tests and bounds). */
  get size() { return this.drafts.size; }
}

/** The process's drafts: the gateway writes them and the event streams of this process read them. */
let shared: ReplyDrafts | undefined;
export const replyDrafts = () => (shared ??= new ReplyDrafts());
