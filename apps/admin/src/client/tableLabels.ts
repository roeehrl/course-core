/**
 * On phones every admin table is drawn as a list of cards (styles.css), and each value shows its
 * column name beside it from the cell's `data-label`. Rather than repeat every column heading on
 * every cell by hand, one document-level observer copies the visible text of each column heading
 * (`<thead> <th>`) into the body cells of that column. A cell that already has a `data-label`
 * keeps it (an empty one means "no label", as for a row's action buttons).
 */
const OWN = "data-label-auto";

function headings(table: HTMLTableElement): string[] {
  const row = table.tHead?.rows[0];
  if (!row) return [];
  const names: string[] = [];
  for (const cell of Array.from(row.cells)) {
    const name = (cell.textContent ?? "").replace(/\s+/g, " ").trim();
    for (let span = 0; span < Math.max(1, cell.colSpan); span++)
      names.push(name);
  }
  return names;
}

/** Labels the body cells of one table from its column headings. */
export function labelTableCells(table: HTMLTableElement) {
  const names = headings(table);
  if (names.length === 0) return;
  for (const body of Array.from(table.tBodies))
    for (const row of Array.from(body.rows)) {
      let column = 0;
      for (const cell of Array.from(row.cells)) {
        const name = names[column] ?? "";
        column += Math.max(1, cell.colSpan);
        // Row headings are the card's title; they carry no label.
        if (cell.tagName === "TH") continue;
        if (cell.hasAttribute("data-label") && !cell.hasAttribute(OWN))
          continue;
        if (cell.getAttribute("data-label") !== name) {
          cell.setAttribute("data-label", name);
          cell.setAttribute(OWN, "");
        }
      }
    }
}

/** Keeps every table under `root` labelled as rows and headings change; returns the uninstaller. */
export function installTableCellLabels(
  root: Node | undefined = typeof document === "undefined"
    ? undefined
    : document.body,
): () => void {
  if (!root || typeof MutationObserver === "undefined") return () => {};
  let queued = false;
  const run = () => {
    queued = false;
    const scope = root as ParentNode;
    for (const table of Array.from(scope.querySelectorAll("table")))
      labelTableCells(table);
  };
  const observer = new MutationObserver((records) => {
    // Our own attribute writes are not childList/characterData changes, so they do not loop.
    if (queued || records.every((r) => r.type === "attributes")) return;
    queued = true;
    queueMicrotask(run);
  });
  observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  run();
  return () => observer.disconnect();
}
