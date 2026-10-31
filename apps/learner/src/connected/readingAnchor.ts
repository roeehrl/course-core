/**
 * Keeps the text being read where it is on the screen while the layout beside it changes (the
 * companion pane opening or closing narrows or widens the lesson column, and its paragraphs
 * reflow). Before the change, `readingAnchor` finds the line of lesson text being read;
 * after it, `restoreReadingAnchor` scrolls the window by however far that same character moved.
 * Browser scroll anchoring does not do this: WebKit has none, and in Chromium it picked a node that
 * left the text about 100 px lower on a tablet (0.1.60 qualification).
 */
export interface ReadingAnchor {
  readonly node: Node;
  readonly offset: number;
  readonly top: number;
}

type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as CaretDocument;
  if (typeof doc.caretPositionFromPoint === "function") {
    const position = doc.caretPositionFromPoint(x, y);
    return position ? { node: position.offsetNode, offset: position.offset } : null;
  }
  if (typeof doc.caretRangeFromPoint === "function") {
    const range = doc.caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }
  return null;
}

/** The drawn top of the character at `offset` in a text node (or of the element), or undefined. */
function topOf(node: Node, offset: number): number | undefined {
  if (!node.isConnected) return undefined;
  if (node.nodeType === Node.TEXT_NODE) {
    const length = (node as Text).data.length;
    if (!length) return undefined;
    const range = document.createRange();
    const start = Math.min(offset, length - 1);
    range.setStart(node, start);
    range.setEnd(node, start + 1);
    const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
    return rect && (rect.width || rect.height) ? rect.top : undefined;
  }
  return node instanceof Element ? node.getBoundingClientRect().top : undefined;
}

/** The line of text in `column` where reading happens: the first one at or below a third of the
 * way down the visible part of the window (under the header), probed across the column, or above
 * it when nothing is below. Null when no lesson text is in view. (The first line under the header
 * is often a part label above the paragraph, which stays put while the paragraph reflows.) */
export function readingAnchor(column: Element | null, topEdge: number): ReadingAnchor | null {
  if (!column) return null;
  const box = column.getBoundingClientRect();
  const top = Math.max(box.top, topEdge), bottom = Math.min(box.bottom, window.innerHeight);
  if (bottom <= top) return null;
  const start = top + (bottom - top) / 3;
  const xs = [box.left + box.width / 2, box.left + box.width / 4, box.left + (box.width * 3) / 4];
  const at = (y: number): ReadingAnchor | null => {
    for (const x of xs) {
      const caret = caretAt(x, y);
      if (!caret || caret.node.nodeType !== Node.TEXT_NODE || !column.contains(caret.node)) continue;
      if (!(caret.node as Text).data.trim()) continue;
      const drawn = topOf(caret.node, caret.offset);
      if (drawn !== undefined && drawn >= topEdge - 1) return { node: caret.node, offset: caret.offset, top: drawn };
    }
    return null;
  };
  for (let y = start; y < bottom; y += 6) {
    const found = at(y);
    if (found) return found;
  }
  for (let y = start - 6; y > top; y -= 6) {
    const found = at(y);
    if (found) return found;
  }
  return null;
}

/** Scrolls the window so the anchored character is drawn at its earlier height again. */
export function restoreReadingAnchor(anchor: ReadingAnchor) {
  const top = topOf(anchor.node, anchor.offset);
  if (top === undefined) return;
  const shift = top - anchor.top;
  if (Math.abs(shift) >= 1) window.scrollBy({ top: shift, behavior: "instant" as ScrollBehavior });
}
