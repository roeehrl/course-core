/**
 * What the learner is pointing at for their next companion message: a selection
 * in the lesson (text, their own code lines or a labelled part of an
 * illustration) and the course video with its position. Components publish
 * here; the companion panel shows it with a remove control, and the companion
 * client attaches it to the next message only (then clears it). The server
 * resolves it against the current course and refuses a stale selection.
 * In memory only: never stored on the device.
 */
export type FocusSelection =
  | { kind: "text"; excerpt: string }
  | {
      kind: "code";
      excerpt: string;
      lineStart: number;
      lineEnd: number;
      codeSnapshotHash: string;
    }
  | { kind: "visual_node"; blockId: string; nodeId: string; label: string };
export interface FocusMedia {
  mediaId: string;
  label: string;
  playbackSeconds?: number;
}
export interface CompanionFocusState {
  selection?: FocusSelection;
  media?: FocusMedia;
}
let state: CompanionFocusState = {};
const listeners = new Set<(value: CompanionFocusState) => void>();
function publish(next: CompanionFocusState) {
  state = next;
  for (const listener of listeners) listener(state);
}
export const companionFocus = {
  get: (): CompanionFocusState => state,
  setSelection(selection: FocusSelection | undefined) {
    publish({ ...state, selection });
  },
  setMedia(media: FocusMedia | undefined) {
    publish({ ...state, media });
  },
  clear() {
    if (state.selection || state.media) publish({});
  },
  subscribe(listener: (value: CompanionFocusState) => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
const collapse = (value: string) => value.replace(/\s+/g, " ").trim();
/** A bounded text excerpt as the server matches it. */
export function focusExcerpt(value: string, max = 500) {
  return collapse(value).slice(0, max);
}
/** Lines covered by a textarea selection (1-based, inclusive). */
export function selectedLines(value: string, start: number, end: number) {
  const before = value.slice(0, start).split("\n").length;
  const through = value.slice(0, Math.max(start, end - 1)).split("\n").length;
  return { lineStart: before, lineEnd: Math.max(before, through) };
}
export async function sha256Hex(value: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
