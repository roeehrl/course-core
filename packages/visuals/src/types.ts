import type { VisualExperience } from "@course-core/sdk";

export type Value = number | string | boolean;
export type State = Readonly<Record<string, Value>>;
export type Operator =
  | "add"
  | "sub"
  | "mul"
  | "div"
  | "mod"
  | "pow"
  | "min"
  | "max"
  | "clamp"
  | "lerp"
  | "abs"
  | "sqrt"
  | "sin"
  | "cos"
  | "floor"
  | "round"
  | "eq"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "and"
  | "or"
  | "not"
  | "concat"
  | "if";
/** Data-only AST. No source strings, member access, functions, or URL values. */
export type Expression =
  | Value
  | { state: string }
  | { time: true }
  | { sample: string }
  | { op: Operator; args: Expression[] };
export type Paint =
  | string
  | { kind: "linear"; from: string; to: string }
  /** From 0.5: the first colour at the centre (cx, cy, fractions of the node's box), the second at radius r. */
  | {
      kind: "radial";
      from: string;
      to: string;
      cx?: number;
      cy?: number;
      r?: number;
    };
export type StateField =
  | {
      label: string;
      kind: "number";
      initial: number;
      min: number;
      max: number;
      step: number;
    }
  | { label: string; kind: "boolean"; initial: boolean }
  | { label: string; kind: "enum"; initial: string; options: string[] };
export type NumericProperty =
  | "x"
  | "y"
  | "rotation"
  | "scale"
  | "opacity"
  | "width"
  | "height"
  | "radius"
  | "fontSize"
  | "x2"
  | "y2"
  | "progress"
  | "morph";
export interface Manipulation {
  x?: { state: string; from: number; to: number };
  y?: { state: string; from: number; to: number };
  activate?: { state: string; value: Value };
}
export interface NodeBase {
  id: string;
  label?: string;
  x?: Expression;
  y?: Expression;
  rotation?: Expression;
  scale?: Expression;
  opacity?: Expression;
  visible?: Expression;
  fill?: Paint;
  stroke?: string;
  strokeWidth?: number;
  manipulate?: Manipulation;
  /** Id of a clip in `scene.defs.clips`; clip shapes use scene coordinates. */
  clip?: string;
  /** Id of a mask in `scene.defs.masks` (luminance); mask content uses scene coordinates. */
  mask?: string;
}
export type PathCommand =
  | { command: "M"; x: Expression; y: Expression }
  | { command: "L"; x: Expression; y: Expression }
  | {
      command: "C";
      x1: Expression;
      y1: Expression;
      x2: Expression;
      y2: Expression;
      x: Expression;
      y: Expression;
    }
  | {
      command: "Q";
      x1: Expression;
      y1: Expression;
      x: Expression;
      y: Expression;
    }
  | { command: "Z" };
export type Anchor = "center" | "top" | "right" | "bottom" | "left" | "auto";
export type SceneNode = NodeBase &
  (
    | { kind: "group"; children: SceneNode[] }
    | {
        kind: "rect";
        width: Expression;
        height: Expression;
        cornerRadius?: number;
      }
    | { kind: "circle"; radius: Expression }
    | { kind: "ellipse"; width: Expression; height: Expression }
    | { kind: "line"; x2: Expression; y2: Expression; progress?: Expression }
    | {
        kind: "text";
        text: Expression;
        fontSize?: Expression;
        weight?: "normal" | "bold";
        align?: "start" | "middle" | "end";
      }
    | {
        kind: "path";
        commands: PathCommand[];
        progress?: Expression;
        /** From 0.5: the shape at morph 1; same command letters as `commands`. */
        morphTo?: PathCommand[];
        /** 0 draws `commands`, 1 draws `morphTo`; in between, every coordinate is interpolated. */
        morph?: Expression;
      }
    | {
        kind: "plot";
        width: Expression;
        height: Expression;
        domainX: [number, number];
        domainY: [number, number];
        points: { x: Expression; y: Expression }[];
        area?: boolean;
      }
    | {
        kind: "link";
        from: { node: string; anchor: Anchor };
        to: { node: string; anchor: Anchor };
        bend?: number;
        arrow?: boolean;
        progress?: Expression;
      }
    | {
        /** An instance of `scene.defs.symbols[symbol]`, scaled to width × height. */
        kind: "use";
        symbol: string;
        width?: Expression;
        height?: Expression;
      }
    | {
        /** From 0.5: an image of `scene.defs.images`, fitted into width × height. `label`
         * is its text alternative and is required. */
        kind: "image";
        image: string;
        width: Expression;
        height: Expression;
        fit?: "contain" | "cover" | "fill";
      }
    | {
        /** A constrained TeX subset (see equation.ts). `label` is required as its text alternative. */
        kind: "equation";
        tex: string;
        fontSize?: Expression;
        align?: "start" | "middle" | "end";
      }
  );
/** Reusable, scene-local definitions. Referenced by id only; never by URL. */
export interface Defs {
  clips?: { id: string; nodes: SceneNode[] }[];
  masks?: { id: string; nodes: SceneNode[] }[];
  symbols?: { id: string; width: number; height: number; nodes: SceneNode[] }[];
  /** From 0.5: embedded raster images. `data` is base64; `sha256` must match its bytes. */
  images?: ImageAsset[];
}
/** An embedded PNG, JPEG or WebP image, verified against its declared digest at parse time. */
export interface ImageAsset {
  id: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  /** Intrinsic size in pixels: the aspect ratio the image is fitted with. */
  width: number;
  height: number;
  /** `sha256-` and 64 lowercase hex digits over the decoded bytes. */
  sha256: string;
  data: string;
}
/** Features a scene can require from a renderer (SDK RenderFeature values plus `symbol`). */
export type SceneFeature =
  | "gradient"
  | "path_draw"
  | "clip"
  | "mask"
  | "equation"
  | "symbol"
  | "spring"
  | "stagger"
  | "layout_set"
  | "panes"
  | "invariants"
  | "goldens"
  | "image"
  | "radial_gradient"
  | "equation_environments"
  | "morph"
  | "color_animation"
  | "camera";
/**
 * An invariant's expression: the ordinary expression forms plus probes that read the
 * computed frame, so one assertion can compare representations (geometry, panes, state).
 */
export type Probe =
  | Value
  | { state: string }
  | { time: true }
  | { sample: string }
  | { op: Operator; args: Probe[] }
  /** A node's computed property; worldX/worldY are its translation in scene space. */
  | { node: string; property: NumericProperty | "worldX" | "worldY" }
  /** The value a table pane's cell evaluates to (row is a 0-based index). */
  | { cell: { pane: string; row: Probe; column: number } }
  /** A formula pane's value for one symbol. */
  | { value: { pane: string; symbol: string } }
  /** A table pane's highlighted row or a code pane's highlighted line; -1 when none. */
  | { highlight: string };
/** A data-only assertion checked at publish over times, states and every layout. */
export interface Invariant {
  id: string;
  description: string;
  assert: Probe;
  /** Times to check; defaults to 0, every cue and the duration. */
  times?: number[];
  /** State overrides to check besides the initial state. */
  states?: Record<string, Value>[];
}
/** The expected digest of a frame (initial state) at a time and layout. */
export interface Golden {
  atMs: number;
  layout: LayoutMode;
  digest: string;
}
/** Layout modes: the two-layout form (compact/expanded) or the four-layout set. */
export type LayoutMode =
  | "compact"
  | "expanded"
  | "tabletPortrait"
  | "tabletLandscape"
  | "wide";
export type Ease = "linear" | "smooth" | "in" | "out" | "step" | "spring";
/** Damped spring parameters (unit mass-spring-damper, integrated at a fixed step). */
export interface Spring {
  stiffness: number;
  damping: number;
  mass: number;
}
export interface Keyframe {
  atMs: number;
  value: number;
  ease?: Ease;
  /** Only with ease "spring"; defaults to stiffness 170, damping 26, mass 1. */
  spring?: Spring;
}
/** A colour keyframe; colours interpolate per sRGB channel, alpha included. */
export interface ColorKeyframe {
  atMs: number;
  color: string;
  ease?: Exclude<Ease, "spring">;
}
/** From 0.5: animates a node's solid fill or stroke colour. */
export interface ColorTrack {
  node: string;
  property: "fill" | "stroke";
  keyframes: ColorKeyframe[];
}
/** From 0.5: the view onto the scene. (x, y) is the scene point at the centre; zoom > 1 enlarges. */
export interface Camera {
  x?: Expression;
  y?: Expression;
  zoom?: Expression;
}
export interface CameraTrack {
  property: "x" | "y" | "zoom";
  keyframes: Keyframe[];
}
/** One keyframe list applied to several nodes, each starting `delayMs` after the previous. */
export interface Stagger {
  nodes: string[];
  property: NumericProperty;
  delayMs: number;
  keyframes: Keyframe[];
}
/** HTML panes synchronized with the frame: same state, time and computation as the SVG. */
export type Pane =
  | {
      id: string;
      kind: "table";
      title: string;
      columns: string[];
      rows: Expression[][];
      /** 0-based row index to mark as current; out of range marks none. */
      highlightRow?: Expression;
    }
  | {
      id: string;
      kind: "code";
      title: string;
      language: string;
      lines: string[];
      /** 1-based line number to mark as current; out of range marks none. */
      highlightLine?: Expression;
    }
  | {
      id: string;
      kind: "formula";
      title: string;
      tex: string;
      label: string;
      values?: { symbol: string; value: Expression }[];
    };
export type PaneFrame =
  | {
      id: string;
      kind: "table";
      title: string;
      columns: string[];
      rows: string[][];
      highlightRow: number | null;
    }
  | {
      id: string;
      kind: "code";
      title: string;
      language: string;
      lines: string[];
      highlightLine: number | null;
    }
  | {
      id: string;
      kind: "formula";
      title: string;
      tex: string;
      label: string;
      values: { symbol: string; value: string }[];
    };
export interface Layout {
  width: number;
  height: number;
  overrides?: Record<string, Partial<Record<NumericProperty, Expression>>>;
}
export interface Track {
  node: string;
  property: NumericProperty;
  keyframes: Keyframe[];
}
export interface Scene {
  version: 1;
  id: string;
  title: string;
  description: string;
  state: Record<string, StateField>;
  controls?: string[];
  nodes: SceneNode[];
  defs?: Defs;
  camera?: Camera;
  layouts: {
    compact: Layout;
    expanded: Layout;
    breakpoint?: number;
    /** The four-layout set: all three or none, with `compact`. `expanded` stays the
     * fallback for renderers without the layout_set feature. */
    tabletPortrait?: Layout;
    tabletLandscape?: Layout;
    wide?: Layout;
  };
  timeline: {
    durationMs: number;
    tracks: Track[];
    staggers?: Stagger[];
    colorTracks?: ColorTrack[];
    cameraTracks?: CameraTrack[];
    cues: { atMs: number; text: string }[];
  };
  panes?: Pane[];
  accessibility: {
    text: string;
    reducedMotion: { atMs: number; description: string };
  };
  simulation?: {
    seed: number;
    stepMs: number;
    updates: Record<string, Expression>;
  };
  referenceChecks?: string[];
  invariants?: Invariant[];
  goldens?: Golden[];
}
export interface Point {
  x: number;
  y: number;
}
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type Matrix = readonly [number, number, number, number, number, number];
export interface GeometryNode {
  id: string;
  kind: SceneNode["kind"];
  label?: string;
  matrix: Matrix;
  parentMatrix: Matrix;
  bounds: Bounds;
  opacity: number;
  visible: boolean;
  fill: Paint;
  stroke: string;
  strokeWidth: number;
  x: number;
  y: number;
  rotation: number;
  scale: number;
  width: number;
  height: number;
  radius: number;
  fontSize: number;
  x2: number;
  y2: number;
  progress: number;
  /** Only on paths with `morphTo`. */
  morph?: number;
  cornerRadius: number;
  text?: string;
  weight?: "normal" | "bold";
  align?: "start" | "middle" | "end";
  path?: string;
  points?: Point[];
  arrow?: boolean;
  manipulate?: Manipulation;
  children?: GeometryNode[];
  clip?: string;
  mask?: string;
  symbol?: string;
  equation?: EquationLayout;
  /** Image nodes: the asset id and how it is fitted. */
  image?: string;
  fit?: "contain" | "cover" | "fill";
}
/** A laid-out equation in the node's local pixels; baseline at y = 0. */
export interface EquationLayout {
  tex: string;
  width: number;
  ascent: number;
  descent: number;
  offset: number;
  glyphs: {
    x: number;
    y: number;
    text: string;
    size: number;
    width: number;
    style: "italic" | "normal" | "bold";
  }[];
  rules: { x: number; y: number; width: number; height: number }[];
  strokes: { d: string; width: number }[];
}
export interface FrameDefs {
  clips: { id: string; nodes: GeometryNode[] }[];
  masks: { id: string; nodes: GeometryNode[] }[];
  symbols: {
    id: string;
    width: number;
    height: number;
    nodes: GeometryNode[];
  }[];
  /** Present only when the scene has images. */
  images?: readonly ImageAsset[];
}
/** The resolved camera (present only when the scene has one). */
export interface FrameCamera {
  x: number;
  y: number;
  zoom: number;
}
export interface Frame {
  sceneId: string;
  layout: LayoutMode;
  width: number;
  height: number;
  timeMs: number;
  durationMs: number;
  state: State;
  nodes: GeometryNode[];
  text: string;
  cue: string;
  reducedMotion: boolean;
  /** Present only when the scene has defs. */
  defs?: FrameDefs;
  /** Present only when the scene has panes. */
  panes?: PaneFrame[];
  /** Present only when the scene has a camera. */
  camera?: FrameCamera;
}
export interface ReplayEvent {
  atMs: number;
  changes: Record<string, Value>;
}
export interface Replay {
  version: 1;
  sceneId: string;
  sceneFingerprint: string;
  seed: number;
  events: ReplayEvent[];
}
export interface CheckResult {
  id: string;
  passed: boolean;
  message?: string;
}
export type ReferenceCheck = (frame: Readonly<Frame>) => {
  passed: boolean;
  message?: string;
};
export interface RuntimeOptions {
  viewportWidth?: number;
  reducedMotion?: boolean;
  seed?: number;
  /** Trusted host callbacks, never loaded from scene JSON. Not grading authority. */
  referenceChecks?: Readonly<Record<string, ReferenceCheck>>;
}
export type SDKVisualExperience = VisualExperience;
