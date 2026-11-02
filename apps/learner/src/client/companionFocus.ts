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
/** An open check attached to the next message, with its number in the lesson ("Question 2"). */
export interface FocusCheck {
  challengeId: string;
  ordinal: number;
}
export interface CompanionFocusState {
  selection?: FocusSelection;
  media?: FocusMedia;
  check?: FocusCheck;
}
let state: CompanionFocusState = {};
const listeners = new Set<(value: CompanionFocusState) => void>();
/** Where each attachment is in the page (the check, the lesson block, the player, the
 * illustration), newest last; never sent, only used to show it above a phone's sheet. */
type Place = keyof CompanionFocusState;
let places: { place: Place; element: Element }[] = [];
function publish(next: CompanionFocusState) {
  state = next;
  places = places.filter(({ place }) => next[place] !== undefined);
  for (const listener of listeners) listener(state);
}
function placed(place: Place, element: Element | null | undefined, value: unknown) {
  places = places.filter((row) => row.place !== place);
  if (value !== undefined && element) places.push({ place, element });
}
export const companionFocus = {
  get: (): CompanionFocusState => state,
  /** `element` is where the selection is in the page (its block, the code field, the illustration). */
  setSelection(selection: FocusSelection | undefined, element?: Element | null) {
    placed("selection", element, selection);
    publish({ ...state, selection });
  },
  /** `element` is the player the moment was taken from. */
  setMedia(media: FocusMedia | undefined, element?: Element | null) {
    placed("media", element, media);
    publish({ ...state, media });
  },
  /** Attaches an open check to the next message (sent as its `challengeId`), or removes it;
   * `element` is the check in the lesson. */
  setCheck(check: FocusCheck | undefined, element?: Element | null) {
    placed("check", element, check);
    publish({ ...state, check });
  },
  /** The page element of the newest attachment still on the page, if any (final design §2.4 G6). */
  anchor(): Element | null {
    return places.findLast(({ element }) => element.isConnected)?.element ?? null;
  },
  clear() {
    if (state.selection || state.media || state.check) publish({});
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
/** Lower-case hex SHA-256; also works on a non-secure (plain http) origin. */
export { sha256Hex } from "./webCrypto";
