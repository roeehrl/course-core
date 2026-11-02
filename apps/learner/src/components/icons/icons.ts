/**
 * The learner app's icon set (final design §1.4): one inline stroke set in the Lucide style, round
 * caps and joins, drawn so the stroke is 1.75 px at every size (16 px in action rows and meta
 * lines, 18 px inside Send and Stop, 20 px elsewhere). Stroke icons use the 24-unit Lucide grid;
 * the companion glyph and the credit pair are drawn on their own grids and coloured from tokens.
 */
export type IconNode =
  | ["path", { d: string }]
  | ["circle", { cx: number; cy: number; r: number }]
  | ["rect", { x: number; y: number; width: number; height: number; rx?: number }];

export interface IconDefinition {
  /** The grid the nodes are drawn on (a square viewBox). */
  grid: 16 | 20 | 24;
  nodes: readonly IconNode[];
  /** Mirrored in right-to-left text (RTL-4): chevrons, arrows that point along the line, panel-right. */
  mirror?: boolean;
  /** Drawn with fills instead of a stroke (the companion glyph, Counts). */
  paint?: "sparkle" | "counts" | "practice";
}

const path = (d: string): IconNode => ["path", { d }];
const circle = (cx: number, cy: number, r: number): IconNode => ["circle", { cx, cy, r }];
const rect = (x: number, y: number, width: number, height: number, rx?: number): IconNode => [
  "rect",
  rx === undefined ? { x, y, width, height } : { x, y, width, height, rx },
];
const stroke = (nodes: IconNode[], mirror?: true): IconDefinition => (mirror ? { grid: 24, nodes, mirror } : { grid: 24, nodes });

const DEFINITIONS = {
  /** The companion glyph: a filled four-point star in `--companion`. */
  sparkle: {
    grid: 20,
    paint: "sparkle",
    nodes: [path("M10 1.5C10.6 6.2 13.8 9.4 18.5 10C13.8 10.6 10.6 13.8 10 18.5C9.4 13.8 6.2 10.6 1.5 10C6.2 9.4 9.4 6.2 10 1.5Z")],
  },
  /** Credit pair, Counts: a filled `--accent` circle with a check mark. */
  counts: { grid: 16, paint: "counts", nodes: [circle(8, 8, 8), path("M4.9 8.3 7 10.3l4.1-4.5")] },
  /** Credit pair, Practice: a dashed open circle in `--ink-muted` (dash 2.5, gap 2). */
  practice: { grid: 16, paint: "practice", nodes: [circle(8, 8, 6.5)] },
  "arrow-up": stroke([path("m5 12 7-7 7 7"), path("M12 19V5")]),
  "arrow-down": stroke([path("M12 5v14"), path("m19 12-7 7-7-7")]),
  "arrow-right": stroke([path("M5 12h14"), path("m12 5 7 7-7 7")], true),
  square: stroke([rect(4, 4, 16, 16, 2)]),
  clock: stroke([circle(12, 12, 10), path("M12 6v6l4 2")]),
  copy: stroke([rect(8, 8, 14, 14, 2), path("M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2")]),
  check: stroke([path("M20 6 9 17l-5-5")]),
  "thumb-up": stroke([
    path("M7 10v12"),
    path("M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"),
  ]),
  "thumb-down": stroke([
    path("M17 14V2"),
    path("M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"),
  ]),
  "more-horizontal": stroke([circle(12, 12, 1), circle(19, 12, 1), circle(5, 12, 1)]),
  "chevron-down": stroke([path("m6 9 6 6 6-6")], true),
  "chevron-up": stroke([path("m18 15-6-6-6 6")], true),
  "chevron-right": stroke([path("m9 18 6-6-6-6")], true),
  "chevron-left": stroke([path("m15 18-6-6 6-6")], true),
  "chevrons-up-down": stroke([path("m7 15 5 5 5-5"), path("m7 9 5-5 5 5")], true),
  info: stroke([circle(12, 12, 10), path("M12 16v-4"), path("M12 8h.01")]),
  x: stroke([path("M18 6 6 18"), path("m6 6 12 12")]),
  "maximize-2": stroke([path("M15 3h6v6"), path("M9 21H3v-6"), path("M21 3l-7 7"), path("M3 21l7-7")]),
  "panel-right": stroke([rect(3, 3, 18, 18, 2), path("M15 3v18")], true),
  "book-open": stroke([
    path("M12 7v14"),
    path("M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"),
  ]),
  quote: stroke([
    path("M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"),
    path("M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"),
  ]),
  code: stroke([path("m16 18 6-6-6-6"), path("m8 6-6 6 6 6")]),
  image: stroke([rect(3, 3, 18, 18, 2), circle(9, 9, 2), path("m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21")]),
  play: stroke([path("M6 3 20 12 6 21Z")]),
  "alert-circle": stroke([circle(12, 12, 10), path("M12 8v4"), path("M12 16h.01")]),
  "rotate-ccw": stroke([path("M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"), path("M3 3v5h5")]),
  pencil: stroke([
    path("M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"),
    path("m15 5 4 4"),
  ]),
  "trash-2": stroke([
    path("M3 6h18"),
    path("M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"),
    path("M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"),
    path("M10 11v6"),
    path("M14 11v6"),
  ]),
  bell: stroke([path("M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"), path("M10.3 21a1.94 1.94 0 0 0 3.4 0")]),
  "wifi-off": stroke([
    path("M12 20h.01"),
    path("M8.5 16.43a5 5 0 0 1 7 0"),
    path("M5 12.86a10 10 0 0 1 5.17-2.69"),
    path("M19 12.86a10 10 0 0 0-2-1.52"),
    path("M2 8.82a15 15 0 0 1 4.18-2.64"),
    path("M22 8.82a15 15 0 0 0-11.29-3.76"),
    path("m2 2 20 20"),
  ]),
  "pause-circle": stroke([circle(12, 12, 10), path("M10 15V9"), path("M14 15V9")]),
  lock: stroke([rect(3, 11, 18, 11, 2), path("M7 11V7a5 5 0 0 1 10 0v4")]),
  "shield-check": stroke([
    path("M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"),
    path("m9 12 2 2 4-4"),
  ]),
  "eye-off": stroke([
    path("M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"),
    path("M14.084 14.158a3 3 0 0 1-4.242-4.242"),
    path("M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"),
    path("m2 2 20 20"),
  ]),
  lightbulb: stroke([
    path("M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"),
    path("M9 18h6"),
    path("M10 22h4"),
  ]),
  "corner-down-left": stroke([path("M20 4v7a4 4 0 0 1-4 4H4"), path("m9 10-5 5 5 5")], true),
  "external-link": stroke(
    [path("M15 3h6v6"), path("M10 14 21 3"), path("M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6")],
    true,
  ),
} satisfies Record<string, IconDefinition>;

export type IconName = keyof typeof DEFINITIONS;
export const ICONS: Readonly<Record<IconName, IconDefinition>> = DEFINITIONS;
export type IconSize = 16 | 18 | 20;

export const ICON_NAMES = Object.keys(ICONS) as IconName[];

/** The stroke width, in the icon's own units, that draws 1.75 px at this size. */
export const strokeWidth = (icon: IconDefinition, size: IconSize) => (1.75 * icon.grid) / size;
