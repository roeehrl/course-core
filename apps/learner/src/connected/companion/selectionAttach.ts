import { companionFocus, focusExcerpt, selectedLines, sha256Hex, type FocusSelection } from "../../client/companionFocus";
import { companionBridge } from "./bridge";

/**
 * Asking the companion about a selection (final design §3.9): nothing the learner selects is
 * attached until they press "Ask companion" (or the companion shortcut). This module finds what a
 * selection may attach (lesson text, or lines of the learner's own code), where the floating
 * button goes, and attaches it: the selection becomes the next message's focus and the companion
 * opens with its composer.
 */

/** M18: the floating button appears once the selection has not changed for this long. */
export const ASK_STABLE_MS = 300;
/** The button sits this far below the end of the selection. */
export const ASK_GAP = 8;
/** It never comes closer than this to the window's edges. */
export const ASK_MARGIN = 8;
/** The floating button's class: the code editor keeps its offer while focus moves to it. */
export const ASK_BUTTON_CLASS = "cc-ask-float";

const LESSON = ".connected-lesson";
const COMPANION = "#connected-companion";
const FIELD = "input,textarea,select,[contenteditable]:not([contenteditable='false'])";

/** A box in window coordinates. */
export interface EdgeBox {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** A selection the learner may ask about. */
export interface AskCandidate {
  kind: "text" | "code";
  /** The same selection gives the same key (a scroll or a repeated event changes nothing). */
  key: string;
  /** The box of the selection's last line; the button lines up with its end. */
  end: EdgeBox;
  direction: "ltr" | "rtl";
  /** The element the selection is in (the code field for code). */
  origin: HTMLElement;
  /** Where the selection ends in the document: Tab from the button continues from here. */
  endNode: Node;
  /** What goes with the next message. */
  build(): FocusSelection | Promise<FocusSelection>;
}

const nodeIds = new WeakMap<Node, number>();
let nextNodeId = 1;
function nodeId(node: Node) {
  let id = nodeIds.get(node);
  if (id === undefined) nodeIds.set(node, (id = nextNodeId++));
  return id;
}
const elementOf = (node: Node | null) => (node ? (node instanceof Element ? node : node.parentElement) : null);
/** Inside the lesson, and neither in a field nor in the companion. */
function inLessonText(node: Node | null) {
  const element = elementOf(node);
  return !!element?.closest(LESSON) && !element.closest(FIELD) && !element.closest(COMPANION);
}
function directionOf(element: Element | null): "ltr" | "rtl" {
  try {
    return element && getComputedStyle(element).direction === "rtl" ? "rtl" : "ltr";
  } catch {
    return "ltr";
  }
}

/** The box of a range's last drawn line (the end of the selection), or null when nothing is drawn. */
function lastLineBox(range: Range): EdgeBox | null {
  if (typeof range.getClientRects !== "function") return null;
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
  const last = rects.at(-1);
  if (!last) return null;
  // Rects on the last line (bidirectional text may draw one line in pieces).
  const line = rects.filter((rect) => rect.top < last.bottom - 1 && rect.bottom > last.top + 1);
  return {
    top: Math.min(...line.map((rect) => rect.top)),
    bottom: Math.max(...line.map((rect) => rect.bottom)),
    left: Math.min(...line.map((rect) => rect.left)),
    right: Math.max(...line.map((rect) => rect.right)),
  };
}

/** Lesson text the learner selected (at least two characters, wholly inside the lesson and
 * outside fields and the companion), or null. */
export function textCandidate(selection: Selection | null): AskCandidate | null {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!inLessonText(range.startContainer) || !inLessonText(range.endContainer)) return null;
  const excerpt = focusExcerpt(range.toString());
  if (excerpt.length < 2) return null;
  const end = lastLineBox(range);
  const origin = elementOf(range.endContainer) as HTMLElement | null;
  if (!end || !origin) return null;
  return {
    kind: "text",
    key: `text:${nodeId(range.startContainer)}:${range.startOffset}:${nodeId(range.endContainer)}:${range.endOffset}`,
    end,
    direction: directionOf(origin),
    origin,
    endNode: range.endContainer,
    build: () => ({ kind: "text", excerpt }),
  };
}

const px = (value: string) => Number.parseFloat(value) || 0;
/** The width of one line of text drawn in a field's font. */
function lineWidth(field: HTMLTextAreaElement, style: CSSStyleDeclaration, text: string) {
  if (!text) return 0;
  const probe = document.createElement("span");
  probe.textContent = text;
  Object.assign(probe.style, {
    position: "absolute",
    visibility: "hidden",
    whiteSpace: "pre",
    font: style.font,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    letterSpacing: style.letterSpacing,
    tabSize: style.tabSize,
  });
  (field.ownerDocument.body ?? field.parentElement)?.appendChild(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return width;
}
/** Where a position in a code field (which never wraps lines) is drawn, kept inside the field. */
function caretBox(field: HTMLTextAreaElement, offset: number): EdgeBox {
  const box = field.getBoundingClientRect();
  const style = getComputedStyle(field);
  const lines = field.value.slice(0, offset).split("\n");
  const lineHeight = px(style.lineHeight) || px(style.fontSize) * 1.5 || 20;
  const top =
    box.top + px(style.borderTopWidth) + px(style.paddingTop) + (lines.length - 1) * lineHeight - field.scrollTop;
  const x =
    box.left + px(style.borderLeftWidth) + px(style.paddingLeft) + lineWidth(field, style, lines.at(-1) ?? "") - field.scrollLeft;
  const clampedTop = Math.min(Math.max(top, box.top), Math.max(box.top, box.bottom - lineHeight));
  const clampedX = Math.min(Math.max(x, box.left), box.right);
  return { top: clampedTop, bottom: clampedTop + lineHeight, left: clampedX, right: clampedX };
}

/** Lines of the learner's code selected in a code field (not only blank space), or null. */
export function codeCandidate(field: HTMLTextAreaElement): AskCandidate | null {
  const { selectionStart: start, selectionEnd: end, value: code } = field;
  if (end <= start || !code.slice(start, end).trim()) return null;
  const lines = selectedLines(code, start, end);
  const excerpt = code.slice(start, end).slice(0, 2000);
  return {
    kind: "code",
    key: `code:${nodeId(field)}:${start}:${end}:${code.length}`,
    // Code is always drawn left to right.
    end: caretBox(field, end),
    direction: "ltr",
    origin: field,
    endNode: field,
    build: async () => ({ kind: "code", excerpt, ...lines, codeSnapshotHash: await sha256Hex(code) }),
  };
}

/**
 * Where the floating button goes: 8 px below the selection's last line, its inline end lined up
 * with the selection's end (its right edge in left-to-right text, its left edge in right-to-left),
 * above the line when there is no room below, and inside the window.
 */
export function askButtonPosition(
  end: EdgeBox,
  size: { width: number; height: number },
  direction: "ltr" | "rtl",
  viewport: { width: number; height: number },
): { top: number; left: number } {
  const below = end.bottom + ASK_GAP;
  const above = end.top - ASK_GAP - size.height;
  const top = below + size.height > viewport.height - ASK_MARGIN && above >= ASK_MARGIN ? above : below;
  const left = direction === "rtl" ? end.left : end.right - size.width;
  return { top, left: Math.max(ASK_MARGIN, Math.min(left, viewport.width - ASK_MARGIN - size.width)) };
}

/**
 * Attaches a selection to the next message and opens the companion with its composer (the
 * placeholder follows the source). `focus: false` keeps a touch keyboard down, so a phone's sheet
 * stays at Half until the learner taps the message box.
 */
export function attachCandidate(candidate: AskCandidate, { focus = true }: { focus?: boolean } = {}): void {
  const compose = (selection: FocusSelection) => {
    // Its place in the lesson: the paragraph, item or code field the selection ends in.
    companionFocus.setSelection(selection, candidate.origin.closest("p, li, pre, figure, h1, h2, h3, textarea") ?? candidate.origin);
    companionBridge.compose({ source: candidate.kind === "code" ? "code" : "selection", focus });
  };
  const built = candidate.build();
  if (built instanceof Promise) void built.then(compose, () => undefined);
  else compose(built);
}

/**
 * Whether asking moves focus into the message box: always after a key press (a keyboard user wants
 * to type), and after a pointer press except on a touch screen, where the keyboard stays down so a
 * phone's sheet opens at Half. A click made with the keyboard has `detail` 0.
 */
export function focusAfterAsk(event: { detail?: number } | undefined, coarse: boolean): boolean {
  return event?.detail === 0 || !coarse;
}

/**
 * The code field's offer: a code field publishes its selected lines here (its own selection is
 * not part of the page's text selection), and withdraws them when the selection collapses or
 * focus leaves it for anything but the floating button.
 */
let offered: AskCandidate | null = null;
const offerListeners = new Set<() => void>();
export const codeSelection = {
  current: (): AskCandidate | null => offered,
  offer(candidate: AskCandidate) {
    if (offered?.key === candidate.key) return;
    offered = candidate;
    for (const listener of offerListeners) listener();
  },
  /** Withdraws the offer of this field (another field's offer stays). */
  withdraw(origin: HTMLElement | null) {
    if (!offered || (origin && offered.origin !== origin)) return;
    offered = null;
    for (const listener of offerListeners) listener();
  },
  subscribe(listener: () => void) {
    offerListeners.add(listener);
    return () => void offerListeners.delete(listener);
  },
};

/** True for the floating button (or anything inside it). */
export function isAskButton(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(`.${ASK_BUTTON_CLASS}`);
}

const BLOCK = "p,li,dd,dt,blockquote,pre,figcaption,td,th,h1,h2,h3,h4,h5,h6";
/**
 * Puts focus back where the selection is once the floating button goes away while it has focus
 * (Esc, a scroll): the code field for code; for lesson text, the block the selection ends in,
 * made focusable for as long as it keeps focus. Tab then carries on from the selection, not from
 * the top of the page.
 */
export function focusSelectionEnd(candidate: AskCandidate): void {
  if (candidate.kind === "code") {
    if (candidate.origin.isConnected) candidate.origin.focus({ preventScroll: true });
    return;
  }
  const block = (elementOf(candidate.endNode)?.closest(BLOCK) ?? candidate.origin) as HTMLElement;
  if (!block.isConnected) return;
  if (!block.hasAttribute("tabindex")) {
    block.setAttribute("tabindex", "-1");
    block.addEventListener("blur", () => block.removeAttribute("tabindex"), { once: true });
  }
  block.focus({ preventScroll: true });
}

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
/** The next (or previous) control in Tab order after (before) `node`, skipping the floating button. */
export function tabbableNeighbour(node: Node, forward: boolean): HTMLElement | null {
  const all = Array.from(document.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (element) => !isAskButton(element) && element.tabIndex >= 0 && !element.closest("[hidden],[inert]") && element.getClientRects().length > 0,
  );
  const after = (element: HTMLElement) =>
    element !== node && !element.contains(node) && !!(node.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
  return forward ? all.find(after) ?? null : all.filter((element) => !after(element) && !element.contains(node)).at(-1) ?? null;
}
