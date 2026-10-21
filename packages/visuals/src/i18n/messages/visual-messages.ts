import type { LayoutMode } from "./layout-mode.js";

/**
 * Every user-visible text of the React player, inspector, preview and export controls
 * (0.5). Hosts build these from their own catalogs (a `visuals` namespace translated with
 * their `t()`) and pass `messages` (merged over English) and `locale` (for numbers). Scene
 * text is course content and is never translated here.
 */
export interface VisualMessages {
  layout: Record<LayoutMode, string>;
  invalidScene: string;
  eyebrow: string;
  stillMode: string;
  liveCanvas: string;
  stepError: string;
  play: string;
  pause: string;
  playAnimation: string;
  pauseAnimation: string;
  timeline: string;
  /** The timeline readout, e.g. "1.0 / 4.0 s"; the numbers come formatted. */
  timeReadout: (current: string, total: string) => string;
  /** The timeline slider's spoken value. */
  timelineValue: (seconds: string, cue: string) => string;
  seconds: (value: string) => string;
  milliseconds: (value: string) => string;
  reset: string;
  exploreState: string;
  textEquivalent: string;
  reducedMotionEnabled: string;
  equations: string;
  /** Appended to a draggable part's name for screen readers. */
  dragHint: string;
  /** A lazily loaded visual before it loads. */
  lazyPlaceholder: string;
  lazyLoad: string;
  inspectorTitle: (scene: string) => string;
  scene: string;
  layoutHeading: string;
  time: string;
  features: string;
  none: string;
  changeRefused: string;
  parameters: string;
  inspectorTime: string;
  keyframes: string;
  node: string;
  selectedNode: string;
  computedProperties: (node: string) => string;
  publishChecks: string;
  checkCounts: (invariants: number, goldens: number) => string;
  runChecks: string;
  allChecksPass: string;
  checkKind: Record<"invariant" | "golden", string>;
  devicePreview: string;
  devices: Record<
    "phone" | "tabletPortrait" | "tabletLandscape" | "desktop",
    string
  >;
  previewCaption: (device: string, width: string, layout: string) => string;
  previewTitle: (scene: string, device: string) => string;
  exportHeading: string;
  downloadSvg: string;
  downloadPng: string;
  exportDone: (file: string) => string;
  exportFailed: string;
}
