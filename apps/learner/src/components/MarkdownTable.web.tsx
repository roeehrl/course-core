import React from "react";
import { useT } from "../i18n";
import { colors } from "./ui";
import { plainText, textDirection, type Align, type Inline } from "./markdown";

const textAlign = (align: Align) => (align === "center" ? "center" : align === "end" ? "end" : "start");

/** A Markdown table as a real table: headers announced with their cells, columns sized to their
 * content, and a sideways-scrolling frame on narrow screens that the keyboard can reach. */
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
  return (
    <div
      role="region"
      aria-label={t("markdownContent.tableRegion")}
      tabIndex={0}
      dir={dir}
      className="markdown-table"
      style={{ overflowX: "auto", maxWidth: "100%", border: `1px solid ${colors.line}`, borderRadius: 12 }}
    >
      <table style={{ borderCollapse: "collapse", minWidth: "100%", fontSize: 14, lineHeight: "21px", color: colors.ink }}>
        <thead>
          <tr>
            {header.map((cell, index) => (
              <th
                key={index}
                scope="col"
                style={{ textAlign: textAlign(align[index] ?? null), padding: "9px 10px", background: colors.mint, fontWeight: 650, borderBottom: `1px solid ${colors.line}`, verticalAlign: "bottom" }}
              >
                {renderInline(cell, `h${index}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, r) => (
            <tr key={r}>
              {cells.map((cell, c) => (
                <td
                  key={c}
                  style={{ textAlign: textAlign(align[c] ?? null), padding: "8px 10px", color: colors.muted, borderTop: r ? `1px solid ${colors.line}` : undefined, verticalAlign: "top" }}
                >
                  {renderInline(cell, `r${r}c${c}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
