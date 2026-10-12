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
  );
export interface Layout {
  width: number;
  height: number;
  overrides?: Record<string, Partial<Record<NumericProperty, Expression>>>;
}
export interface Track {
  node: string;
  property: NumericProperty;
  keyframes: {
    atMs: number;
    value: number;
    ease?: "linear" | "smooth" | "in" | "out" | "step";
  }[];
}
export interface Scene {
  version: 1;
  id: string;
  title: string;
  description: string;
  state: Record<string, StateField>;
  controls?: string[];
  nodes: SceneNode[];
  layouts: { compact: Layout; expanded: Layout; breakpoint?: number };
  timeline: {
    durationMs: number;
    tracks: Track[];
    cues: { atMs: number; text: string }[];
  };
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
}
export interface Frame {
  sceneId: string;
  layout: "compact" | "expanded";
  width: number;
  height: number;
  timeMs: number;
  durationMs: number;
  state: State;
  nodes: GeometryNode[];
  text: string;
  cue: string;
  reducedMotion: boolean;
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
