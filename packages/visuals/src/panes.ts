import { equationMathML } from "./equation.js";
import { VisualError } from "./expression.js";
import { sanitizeMarkup, serializeMarkup } from "./markup.js";
import type { MarkupElement } from "./markup.js";
import type { Frame } from "./types.js";

const PREFIX = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const el = (
  tag: string,
  attrs: MarkupElement["attrs"] = {},
  children: MarkupElement["children"] = [],
): MarkupElement => ({ tag, attrs, children });

/**
 * The frame's synchronized panes as a sanitized HTML tree, or undefined when the scene has
 * none. Pane values come from the frame, so a table row, a code line and a formula's values
 * always describe the same state and time as the SVG beside them. The React player and the
 * headless renderPanes render this same tree.
 */
export function buildPanesMarkup(
  frame: Frame,
  options: { idPrefix: string },
): MarkupElement | undefined {
  if (!frame.panes) return undefined;
  const uid = options.idPrefix;
  if (!PREFIX.test(uid))
    throw new VisualError("ID_PREFIX", "idPrefix must be a short identifier");
  const current = { class: "ccv-current", "aria-current": "true" };
  return sanitizeMarkup(
    el(
      "div",
      { class: "ccv-panes" },
      frame.panes.map((p) => {
        const heading = `${uid}-pane-${p.id}`;
        const body: MarkupElement[] =
          p.kind === "table"
            ? [
                el("table", {}, [
                  el("thead", {}, [
                    el(
                      "tr",
                      {},
                      p.columns.map((c) => el("th", { scope: "col" }, [c])),
                    ),
                  ]),
                  el(
                    "tbody",
                    {},
                    p.rows.map((row, i) =>
                      el(
                        "tr",
                        i === p.highlightRow ? current : {},
                        row.map((cell) => el("td", {}, [cell])),
                      ),
                    ),
                  ),
                ]),
              ]
            : p.kind === "code"
              ? [
                  el(
                    "ol",
                    { class: "ccv-code", "aria-label": `${p.language} code` },
                    p.lines.map((line, i) =>
                      el(
                        "li",
                        {
                          "data-line": i + 1,
                          ...(i + 1 === p.highlightLine ? current : {}),
                        },
                        [el("code", {}, [line])],
                      ),
                    ),
                  ),
                ]
              : [
                  equationMathML(p.tex, p.label),
                  ...(p.values.length
                    ? [
                        el(
                          "dl",
                          {},
                          p.values.flatMap((v) => [
                            el("dt", {}, [v.symbol]),
                            el("dd", {}, [v.value]),
                          ]),
                        ),
                      ]
                    : []),
                ];
        return el(
          "section",
          {
            class: `ccv-pane ccv-pane-${p.kind}`,
            "data-pane-id": p.id,
            "aria-labelledby": heading,
          },
          [el("h3", { id: heading }, [p.title]), ...body],
        );
      }),
    ),
  );
}

/** Deterministic HTML for the frame's panes ("" when the scene has none). */
export function renderPanes(
  frame: Frame,
  options: { idPrefix: string },
): string {
  const tree = buildPanesMarkup(frame, options);
  return tree ? serializeMarkup(tree) : "";
}
