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
export type Paint = string | { kind: "linear"; from: string; to: string };
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
  | "progress";
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
    | { kind: "path"; commands: PathCommand[]; progress?: Expression }
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
  | "panes";
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
