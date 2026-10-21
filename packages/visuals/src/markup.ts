import { visualError } from "./errors.js";
import type { ErrorKey, englishErrorMessages } from "./errors.js";

/** A plain element tree. Both the React view and the headless serializer render this tree. */
export interface MarkupElement {
  tag: string;
  attrs: Record<string, string | number | undefined>;
  children: (MarkupElement | string)[];
  /** Scene node id of a node wrapper, so the React view can attach interaction. Not an attribute. */
  node?: string;
}

const SHAPE = ["transform"];
const PRESENTATION = [
  "id",
  "transform",
  "opacity",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "data-node-id",
  "role",
  "aria-label",
  "aria-labelledby",
  "aria-describedby",
  "aria-hidden",
  "tabindex",
  "class",
  "pointer-events",
];
const MATH = ["aria-hidden"];
/** Every element and attribute the renderer may emit. Nothing else is serialized. */
const SVG_TAGS: Record<string, string[]> = {
  svg: ["viewBox", "data-layout", "style", "xmlns"],
  title: [],
  desc: [],
  defs: [],
  g: ["clip-path", "mask", "font-family"],
  rect: ["x", "y", "width", "height", "rx", ...SHAPE],
  circle: ["r", ...SHAPE],
  ellipse: ["rx", "ry", ...SHAPE],
  line: ["x2", "y2", "pathLength"],
  path: ["d", "pathLength", "marker-end"],
  text: [
    "x",
    "y",
    "font-size",
    "font-weight",
    "font-style",
    "text-anchor",
    "textLength",
    "lengthAdjust",
  ],
  linearGradient: ["x1", "y1", "x2", "y2"],
  radialGradient: ["cx", "cy", "r"],
  image: ["href", "width", "height", "preserveAspectRatio"],
  stop: ["offset", "stop-color"],
  marker: [
    "markerWidth",
    "markerHeight",
    "refX",
    "refY",
    "orient",
    "markerUnits",
  ],
  clipPath: ["clipPathUnits"],
  mask: ["maskUnits", "x", "y", "width", "height"],
  symbol: ["viewBox"],
  use: ["href", "width", "height"],
};
const MATH_TAGS: Record<string, string[]> = {
  math: ["display", "alttext"],
  mrow: [],
  mi: ["mathvariant"],
  mn: ["mathvariant"],
  mo: [],
  mtext: [],
  mspace: ["width"],
  msup: [],
  msub: [],
  msubsup: [],
  mfrac: [],
  msqrt: [],
  mover: ["accent"],
  mtable: ["columnalign"],
  mtr: [],
  mtd: [],
};
const HTML = ["id", "class", "aria-label", "aria-labelledby", "aria-current"];
/** Elements of the HTML panes (synchronized table, code and formula). */
const HTML_TAGS: Record<string, string[]> = {
  div: [],
  section: ["data-pane-id"],
  h3: [],
  table: [],
  thead: [],
  tbody: [],
  tr: [],
  th: ["scope"],
  td: [],
  ol: [],
  li: ["data-line"],
  code: [],
  dl: [],
  dt: [],
  dd: [],
  span: [],
};
const allow = (tags: Record<string, string[]>, common: string[]) =>
  Object.entries(tags).map(
    ([tag, attrs]) => [tag, new Set([...common, ...attrs])] as const,
  );
/**
 * Every element and attribute the renderer may emit, by the kind of tree: an SVG scene, a
 * MathML equation, or HTML panes (which may hold MathML). Nothing else is serialized.
 */
const FAMILIES: Readonly<
  Record<string, Readonly<Record<string, ReadonlySet<string>>>>
> = Object.freeze({
  svg: Object.fromEntries(allow(SVG_TAGS, PRESENTATION)),
  math: Object.fromEntries(allow(MATH_TAGS, MATH)),
  div: Object.fromEntries([
    ...allow(HTML_TAGS, HTML),
    ...allow(MATH_TAGS, MATH),
  ]),
});
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,191}$/;
const COLOR =
  /^(?:#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|none|transparent)$/;
const LOCAL = /^url\(#([A-Za-z][A-Za-z0-9_-]{0,191})\)$/;
const REFERENCES: Readonly<Record<string, readonly string[]>> = {
  fill: ["linearGradient", "radialGradient"],
  stroke: ["linearGradient", "radialGradient"],
  "stop-color": [],
  "clip-path": ["clipPath"],
  mask: ["mask"],
  "marker-end": ["marker"],
};
const FORMAT: Readonly<Record<string, RegExp>> = {
  d: /^[MLCQZ0-9eE.\- ]*$/,
  transform: /^matrix\((?:-?[0-9.e+-]+ ){5}-?[0-9.e+-]+\)$/,
  style: /^aspect-ratio:[0-9.]+\/[0-9.]+$/,
  xmlns: /^http:\/\/www\.w3\.org\/2000\/svg$/,
  "font-family": /^[A-Za-z0-9 ,'-]+$/,
  preserveAspectRatio: /^(?:none|xMidYMid (?:meet|slice))$/,
  columnalign: /^(?:(?:left|center|right) ?){1,16}$/,
  viewBox: /^-?[0-9.e]+ -?[0-9.e]+ [0-9.e]+ [0-9.e]+$/,
};

function fail<K extends ErrorKey>(
  key: K,
  ...params: Parameters<(typeof englishErrorMessages)[K]>
): never {
  throw visualError("SANITIZE", key, ...params);
}

/**
 * Checks a tree against the allowlist: known elements and attributes only, finite numbers,
 * unique well-formed ids, and references (href, url(#…)) that point at an element of the
 * expected kind inside the same tree. Returns the tree unchanged; throws on anything else.
 */
export function sanitizeMarkup(root: MarkupElement): MarkupElement {
  if (!Object.hasOwn(FAMILIES, root.tag))
    fail("markupTreeNotAllowed", { tag: root.tag });
  const ALLOWED = FAMILIES[root.tag]!;
  const ids = new Map<string, string>();
  let count = 0;
  const collect = (el: MarkupElement, depth: number) => {
    if (++count > 100_000 || depth > 64) fail("markupLimits");
    if (!Object.hasOwn(ALLOWED, el.tag))
      fail("markupElementNotAllowed", { tag: el.tag });
    const id = el.attrs.id;
    if (id !== undefined) {
      if (typeof id !== "string" || !ID.test(id)) fail("markupInvalidId");
      if (ids.has(id)) fail("markupDuplicateId", { id });
      ids.set(id, el.tag);
    }
    for (const child of el.children)
      if (typeof child !== "string") collect(child, depth + 1);
  };
  collect(root, 0);
  const check = (el: MarkupElement) => {
    const allowed = ALLOWED[el.tag]!;
    for (const [name, value] of Object.entries(el.attrs)) {
      if (value === undefined) continue;
      if (!allowed.has(name))
        fail("markupAttributeNotAllowed", { name, tag: el.tag });
      if (typeof value === "number") {
        if (!Number.isFinite(value)) fail("markupNotFinite", { name });
        continue;
      }
      if (typeof value !== "string") fail("markupNotText", { name });
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))
        fail("markupControlCharacters", { name });
      if (name === "href" && el.tag === "image") {
        // Only an embedded raster image, verified against its digest at parse time.
        if (
          !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(
            value,
          )
        )
          fail("imageHref");
        continue;
      }
      if (name === "href") {
        const target = /^#([A-Za-z][A-Za-z0-9_-]{0,191})$/.exec(value)?.[1];
        if (!target || ids.get(target) !== "symbol") fail("markupHrefSymbol");
        continue;
      }
      if (Object.hasOwn(REFERENCES, name)) {
        const target = LOCAL.exec(value)?.[1];
        if (target) {
          if (!REFERENCES[name]!.includes(ids.get(target) ?? ""))
            fail("markupLocalReference", { name });
        } else if (!COLOR.test(value)) fail("markupColorOrReference", { name });
        continue;
      }
      if (Object.hasOwn(FORMAT, name)) {
        if (!FORMAT[name]!.test(value))
          fail("markupInvalidAttribute", { name });
        continue;
      }
      if (
        /url\s*\(|[a-z][a-z0-9+.-]*:\s*\S/i.test(value) &&
        !/^(?:aria-label|alttext)$/.test(name)
      )
        fail("markupUrl", { name });
    }
    for (const child of el.children)
      if (typeof child !== "string") check(child);
  };
  check(root);
  return root;
}

/** The escaping React DOM uses, so the serializer and the React view emit the same bytes. */
export function escapeMarkup(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
        ? "&lt;"
        : c === ">"
          ? "&gt;"
          : c === '"'
            ? "&quot;"
            : "&#x27;",
  );
}

/** Serializes a sanitized tree. */
export function serializeMarkup(el: MarkupElement): string {
  let attrs = "";
  for (const [name, value] of Object.entries(el.attrs))
    if (value !== undefined)
      attrs += ` ${name}="${escapeMarkup(String(value))}"`;
  let inner = "";
  let text = false;
  for (const child of el.children) {
    // React separates adjacent text nodes with an empty comment; mirror it for parity.
    if (typeof child === "string") {
      inner += (text ? "<!-- -->" : "") + escapeMarkup(child);
      text = true;
    } else {
      inner += serializeMarkup(child);
      text = false;
    }
  }
  return `<${el.tag}${attrs}>${inner}</${el.tag}>`;
}
