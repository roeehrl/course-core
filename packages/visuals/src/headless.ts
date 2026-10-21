export type * from "./types.js";
export {
  VisualError,
  evaluate,
  finite,
  seededSample,
  MAX_VALUE,
} from "./expression.js";
export { LIMITS, parseScene } from "./schema.js";
export { SUPPORTED_FEATURES, sceneFeatures } from "./features.js";
export {
  EQUATION_LIMITS,
  equationMathML,
  layoutEquation,
  parseTex,
} from "./equation.js";
export type { MathNode } from "./equation.js";
export { escapeMarkup, sanitizeMarkup, serializeMarkup } from "./markup.js";
export type { MarkupElement } from "./markup.js";
export { buildSceneMarkup, cameraViewBox, renderSvg } from "./svg.js";
export { CompletionLatch } from "./completion.js";
export type { VisualCompletion } from "./completion.js";
export {
  decodeBase64,
  imageSignatureMatches,
  verifyImageAsset,
} from "./image.js";
export { sha256Bytes } from "./digest.js";
export {
  englishErrorMessages,
  errorText,
  visualError,
  VisualCatalogError,
} from "./errors.js";
export type { ErrorKey } from "./errors.js";
export {
  englishVisualMessages,
  formatNumber,
  visualMessages,
} from "./messages.js";
export type { VisualMessages } from "./messages.js";
export { buildPanesMarkup, renderPanes } from "./panes.js";
export { OffscreenPause } from "./visibility.js";
export {
  assertSceneChecks,
  checkFrame,
  frameAtWidth,
  frameDigest,
  goldenFrames,
  layoutModes,
  runSceneChecks,
  sha256,
} from "./checks.js";
export type { CheckFailure } from "./checks.js";
export {
  DEFAULT_SPRING,
  LAYOUT_SET_BREAKPOINTS,
  SPRING_LIMITS,
  SPRING_STEP_MS,
  layoutMode,
  layoutWidth,
  springProgress,
} from "./motion.js";
export type { SceneMarkupOptions } from "./svg.js";
export { VisualRuntime, evaluateScene } from "./runtime.js";
export type { RuntimeSnapshot } from "./runtime.js";
export {
  interpolate,
  interpolateColor,
  transformPoint,
  inversePoint,
  multiply,
  boundsOf,
  curveBounds,
  anchorPoint,
  flattenNodes,
} from "./geometry.js";
export {
  RENDERER_ID,
  toVisualExperience,
  fromVisualExperience,
} from "./sdk.js";
