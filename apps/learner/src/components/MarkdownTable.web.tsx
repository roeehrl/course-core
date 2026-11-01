import React, { useRef } from "react";
import { useSidewaysOverflow } from "./useSidewaysOverflow.web";
import { useT } from "../i18n";
import { plainText, textDirection, type Align, type Inline } from "./markdown";

/** A number as a table shows it: digits with separators, a sign, a unit or percent sign. */
const NUMERIC = /^[-+−]?(?:[\d.,\s ]+)(?:%|[a-zA-Z]{1,3})?$/;
/** Where a column's cells sit (final design §3.3): text at the start, numbers at the end, never
 * centred. A column whose every body cell is a number is a number column even unmarked. */
function columnAlign(align: Align, cells: Inline[][]): "start" | "end" {
  if (align === "end") return "end";
  if (align === "start") return "start";
  const values = cells.map((cell) => plainText(cell).trim()).filter(Boolean);
  return values.length > 0 && values.every((value) => NUMERIC.test(value) && /\d/.test(value)) ? "end" : "start";
}

/** A Markdown table as a real table: headers announced with their cells, columns sized to their
 * content, numbers in tabular figures, and a sideways-scrolling frame on narrow screens that the
 * keyboard can reach. */
export function MarkdownTable({
  align,
  header,
  rows,
  renderInline,
}: {
  align: Align[];
  header: Inline[][];
  rows: Inline[][][];
  renderInline: (nodes: Inline[], key: string) => React.ReactNode;
}) {
  const t = useT();
  const dir = textDirection([...header, ...rows.flat()].map(plainText).join(" "));
  const frame = useRef<HTMLDivElement>(null);
  // Wider than its space (the narrow companion pane): a visible scrollbar and a line saying so,
  // not only a faint fade at the edge.
  const overflowing = useSidewaysOverflow(frame);
  const sides = header.map((_, index) => columnAlign(align[index] ?? null, rows.map((row) => row[index] ?? [])));
  return (
    <div className="markdown-wide">
      <div
        ref={frame}
        role="region"
        aria-label={t("markdownContent.tableRegion")}
        tabIndex={0}
        dir={dir}
        className={`markdown-table ${overflowing ? "is-overflowing" : ""}`}
      >
        <table className="markdown-table-grid">
          <thead>
            <tr>
              {header.map((cell, index) => (
                <th key={index} scope="col" className={sides[index] === "end" ? "is-number" : undefined} style={{ textAlign: sides[index] }}>
                  {renderInline(cell, `h${index}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((cells, r) => (
              <tr key={r}>
                {cells.map((cell, c) => (
                  <td key={c} className={sides[c] === "end" ? "is-number" : undefined} style={{ textAlign: sides[c] ?? "start" }}>
                    {renderInline(cell, `r${r}c${c}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* The arrow points to the hidden side: the end of the table's own direction. */}
      {overflowing && (
        <p className="markdown-scroll-hint" data-toward={dir === "rtl" ? "left" : "right"} aria-hidden="true">
          {t("markdownContent.scrollHint")}
        </p>
      )}
    </div>
  );
}
