import { describe, expect, it } from 'vitest';
import { COMPANION_REPLY_MAX_CHARACTERS, releasable, ReplyDrafts, type DraftFrame } from '../src/reply-drafts.js';

const key = { enrollmentId: 'e1', jobId: 'j1', messageId: 'm1' };
function follow(drafts: ReplyDrafts, enrollmentId = 'e1') {
  const frames: DraftFrame[] = [];
  drafts.subscribe(enrollmentId, frame => frames.push(frame));
  return frames;
}
/** What a client holds after applying frames the way the learner app does. */
function rebuild(frames: DraftFrame[]) {
  let text = '';
  for (const frame of frames) if (frame.offset <= text.length) text = text.slice(0, frame.offset) + frame.text;
  return text;
}

describe('reply drafts release text only at safe boundaries (T01)', () => {
  it('releases after a sentence or line end, at a word boundary once enough waits, never inside a word', () => {
    expect(releasable('Compare the val')).toBe(0);
    expect(releasable('Compare the values. Then')).toBe('Compare the values. '.length);
    expect(releasable('First line\nsecond')).toBe('First line\n'.length);
    expect(releasable('שלום עולם. המשך')).toBe('שלום עולם. '.length);
    const long = 'word '.repeat(12) + 'unfinish';
    expect(long.slice(0, releasable(long))).toBe('word '.repeat(12));
    // One unbroken run is released at the hold limit, never through a surrogate pair.
    const emoji = 'a'.repeat(399) + '😀' + 'b';
    expect(releasable(emoji)).toBe(399);
  });
  it('streams frames in order that rebuild the answer, then completes with the remainder', () => {
    const drafts = new ReplyDrafts(), frames = follow(drafts);
    const writer = drafts.open(key)!;
    // Opening is the dispatch signal: an empty streaming frame at once, before any text.
    expect(frames).toEqual([{ jobId: 'j1', messageId: 'm1', offset: 0, text: '', state: 'streaming' }]);
    for (const piece of ['Compare ', 'the values on a number line', '. The one farther', ' left is smaller']) writer.push(piece);
    expect(frames.map(f => f.state)).toEqual(['streaming', 'streaming']);
    expect(rebuild(frames)).toBe('Compare the values on a number line. ');
    writer.complete();
    expect(frames.at(-1)!.state).toBe('complete');
    expect(rebuild(frames.slice(0, -1))).toBe('Compare the values on a number line. The one farther left is smaller');
    // A reconnecting stream gets the whole released text in one frame.
    expect(drafts.current('e1')).toEqual([{ jobId: 'j1', messageId: 'm1', offset: 0, text: 'Compare the values on a number line. The one farther left is smaller', state: 'complete' }]);
  });
  it('withdraws a draft that grows past the stored reply bound and keeps none of its text', () => {
    const drafts = new ReplyDrafts(), frames = follow(drafts), writer = drafts.open(key)!;
    const sentence = 'x'.repeat(99) + '. ';
    for (let i = 0; i * sentence.length <= COMPANION_REPLY_MAX_CHARACTERS; i++) writer.push(sentence);
    expect(frames.at(-1)).toMatchObject({ state: 'withdrawn', reason: 'output_too_large', text: '', offset: 0 });
    writer.push('more. ');
    expect(frames.at(-1)!.state).toBe('withdrawn');
    expect(drafts.current('e1')[0]!.text).toBe('');
  });
  it('a refusal withdraws; a learner cancel stops; later provider text is ignored', () => {
    const drafts = new ReplyDrafts(), frames = follow(drafts), writer = drafts.open(key)!;
    writer.push('Shown so far. ');
    writer.withdraw('provider_refused');
    expect(frames.at(-1)).toMatchObject({ state: 'withdrawn', reason: 'provider_refused', text: '' });
    const second = drafts.open({ ...key, jobId: 'j2' })!;
    second.push('Another. ');
    expect(drafts.cancel('other-enrollment', 'j2')).toBe(false);
    expect(drafts.cancel('e1', 'j2')).toBe(true);
    second.push('Ignored. '); second.complete();
    expect(frames.filter(f => f.jobId === 'j2').map(f => [f.state, f.text])).toEqual([['streaming', ''], ['streaming', 'Another. '], ['cancelled', '']]);
  });
  it('erasure drops every draft and follower and refuses new drafts for the enrollment', () => {
    const drafts = new ReplyDrafts(), frames = follow(drafts), writer = drafts.open(key)!;
    writer.push('Private text. ');
    drafts.forget('e1');
    writer.push('After erasure. '); writer.complete();
    expect(frames).toHaveLength(2);
    expect(drafts.current('e1')).toEqual([]);
    expect(drafts.open({ ...key, jobId: 'j3' })).toBeNull();
    expect(drafts.open({ enrollmentId: 'e2', jobId: 'j4', messageId: 'm4' })).not.toBeNull();
  });
  it('is bounded: drafts expire, the process holds a fixed number, and followers per enrollment are capped', () => {
    let now = 0;
    const drafts = new ReplyDrafts(() => now);
    drafts.open(key)!.complete();
    now += 121_000;
    expect(drafts.current('e1')).toEqual([]);
    for (let i = 0; i < 500; i++) expect(drafts.open({ enrollmentId: `e${i}`, jobId: `j${i}`, messageId: 'm' })).not.toBeNull();
    expect(drafts.open({ enrollmentId: 'x', jobId: 'overflow', messageId: 'm' })).toBeNull();
    now += 601_000;
    expect(drafts.open({ enrollmentId: 'x', jobId: 'after-expiry', messageId: 'm' })).not.toBeNull();
    const many = new ReplyDrafts();
    for (let i = 0; i < 16; i++) expect(many.subscribe('e1', () => {})).not.toBeNull();
    expect(many.subscribe('e1', () => {})).toBeNull();
  });
  it('another enrollment never receives the frames', () => {
    const drafts = new ReplyDrafts(), mine = follow(drafts, 'e1'), theirs = follow(drafts, 'e2');
    drafts.open(key)!.push('Only for e1. ');
    expect(mine).toHaveLength(2); expect(theirs).toHaveLength(0);
  });
});
