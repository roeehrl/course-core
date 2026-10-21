/**
 * English text of the visuals' error messages by key (0.5). A VisualError carries its
 * stable `code`, and errors from this catalog also carry `key` and `params`, so a host can
 * show its own translation; the English text is the error's message.
 */
export const englishErrorMessages = Object.freeze({
  imageNotBase64: () => "Image data must be base64",
  imageWrongType: (p: { image: string; mediaType: string }) =>
    `Image ${p.image} is not a ${p.mediaType} file`,
  imageDigest: (p: { image: string }) =>
    `Image ${p.image} does not match its sha256`,
  imageUnknown: (p: { image: string }) => `Unknown image ${p.image}`,
  imageHref: () => "An image href must be embedded PNG, JPEG or WebP data",
  imageLabel: (p: { node: string }) =>
    `Image ${p.node} requires a label as its text alternative`,
  imageDuplicate: (p: { image: string }) => `Duplicate image ${p.image}`,
  imageReference: (p: { node: string; image: string }) =>
    `Node ${p.node} references undefined image ${p.image}`,
  morphNeedsTarget: (p: { node: string }) =>
    `Path ${p.node}: morph needs morphTo`,
  morphShape: (p: { node: string }) =>
    `Path ${p.node}: morphTo must use the same commands in order`,
  keyframesIncrease: () => "Keyframes must increase within duration",
  colorTrackInvalid: (p: { track: string }) =>
    `Invalid/duplicate colour track ${p.track}`,
  colorTrackGradient: (p: { track: string }) =>
    `Colour track ${p.track}: the node's fill is a gradient`,
  cameraTracksNeedCamera: () => "cameraTracks need a camera",
  cameraTrackDuplicate: (p: { property: string }) =>
    `Duplicate camera track ${p.property}`,
  cameraNumeric: (p: { property: string }) =>
    `camera.${p.property} must be numeric`,
  cameraRange: (p: { property: string }) => `Invalid camera ${p.property}`,
  probeMissingProperty: (p: { node: string; property: string }) =>
    `Node ${p.node} has no ${p.property}`,
  equationEmpty: () => "Equation: empty",
  equationTooLong: () => "Equation: too long",
  equationAsciiTex: () => "Equation: use ASCII TeX; write symbols as macros",
  equationUnsupportedCharacter: () => "Equation: unsupported character",
  invalidSample: () => "Invalid sample seed, tick or label",
  expressionEvaluationBudgetExceeded: () =>
    "Expression evaluation budget exceeded",
  textIsTooLong: () => "Text is too long",
  invalidExpression: () => "Invalid expression",
  expressionsMustBePlainData: () => "Expressions must be plain data",
  unexpectedExpressionFields: () => "Unexpected expression fields",
  invalidStateIdentifier: () => "Invalid state identifier",
  invalidTimeExpression: () => "Invalid time expression",
  unknownOperator: () => "Unknown operator",
  argumentsMustBeDenseArrays: () => "Arguments must be dense arrays",
  expressionArgumentsPlainData: () => "Expression arguments must be plain data",
  expectedBoolean: () => "Expected boolean",
  expressionTextExceedsLimit: () => "Expression text exceeds limit",
  divisionByZero: () => "Division by zero",
  moduloByZero: () => "Modulo by zero",
  exponentOutOfBounds: () => "Exponent out of bounds",
  reversedClampRange: () => "Reversed clamp range",
  unsupportedExpression: () => "Unsupported expression",
  noninvertibleTransform: () => "Noninvertible transform",
  invalidSize: () => "Invalid size",
  opacityProgressRange: () => "Opacity/progress outside 0..1",
  scaleRange: () => "Scale outside .001..100",
  visibilityMustBeBoolean: () => "Visibility must be boolean",
  coordinateNumeric: () => "Coordinate must be a number",
  plotPointsOutsideDomains: () => "Plot points must remain within domains",
  paneHighlightMustBeNumeric: () => "Pane highlight must be numeric",
  idPrefixShort: () => "idPrefix must be a short identifier",
  seedMustBeUint32: () => "Seed must be uint32",
  invalidViewportWidth: () => "Invalid viewport width",
  elapsedTimeCannotBeNegative: () => "Elapsed time cannot be negative",
  expectedStateChanges: () => "Expected state changes",
  tooManyReplayEvents: () => "Too many replay events",
  invalidReplay: () => "Invalid replay",
  replaySceneMismatch: () => "Replay does not match this scene",
  invalidReplayEvent: () => "Invalid replay event",
  jsonStructureLimits: () => "JSON structure exceeds limits",
  jsonNonfinite: () => "JSON contains nonfinite numbers",
  cyclicSceneData: () => "Cyclic scene data",
  onlyPlainJson: () => "Only plain JSON is supported",
  arrayExceedsLimits: () => "Array exceeds limits",
  arraysDenseJson: () => "Arrays must be dense JSON data",
  unsafeObjectKey: () => "Unsafe object key",
  accessorsAreNotAllowed: () => "Accessors are not allowed",
  expectedJsonData: () => "Expected JSON data",
  sceneExceedsByteBudget: () => "Scene exceeds byte budget",
  unknownStateField: () => "Unknown state field",
  numberOutsideStateBounds: () => "Number outside state bounds",
  expectedBooleanState: () => "Expected boolean state",
  unknownEnumValue: () => "Unknown enum value",
  sceneJsonTooLarge: () => "Scene JSON is too large",
  invalidSceneJson: () => "Invalid scene JSON",
  unsupportedRenderer: () =>
    "Unsupported renderer; use the SDK accessibility description as text fallback",
  probeUnknownNode: (p: { node: string }) => `Unknown node ${p.node}`,
  probeHiddenNode: (p: { node: string }) => `Node ${p.node} is hidden`,
  probeUnknownTable: (p: { pane: string }) => `Unknown table ${p.pane}`,
  probeNoCell: (p: { pane: string }) => `No cell in ${p.pane}`,
  probeUnknownFormulaValue: (p: { symbol: string }) =>
    `Unknown formula value ${p.symbol}`,
  probeUnknownHighlight: (p: { pane: string }) => `Unknown highlight ${p.pane}`,
  invariantDoesNotHold: (p: { description: string }) =>
    `${p.description} does not hold`,
  checkFailed: () => "Check failed",
  goldenDiffers: (p: { digest: string; golden: string }) =>
    `Frame digest ${p.digest} differs from the golden ${p.golden}`,
  sceneCheckFailed: (p: {
    check: string;
    id: string;
    layout: string;
    atMs: number;
    message: string;
  }) => `${p.check} ${p.id} at ${p.layout}, ${p.atMs} ms: ${p.message}`,
  nonFinite: (p: { label: string; max: number }) =>
    `${p.label} must be finite and within ±${p.max}`,
  unknownState: (p: { state: string }) => `Unknown state: ${p.state}`,
  invalidArity: (p: { op: string }) => `Invalid arity for ${p.op}`,
  expectedNumbers: (p: { op: string }) => `Expected numbers for ${p.op}`,
  propertyNumeric: (p: { node: string; property: string }) =>
    `${p.node}.${p.property} must be numeric`,
  referenceCheckNotRegistered: () => "Reference check is not registered",
  referenceCheckFailed: () => "Reference check failed",
  sdkIdentifier: () =>
    "Scene and reference-check identifiers must use the released SDK identifier grammar.",
  sdkMetadataDiffers: (p: { field: string }) =>
    `SDK ${p.field} differs from embedded scene`,
  invalidVisual: () => "Invalid visual",
  visualEvaluationFailed: () => "Visual evaluation failed",
  markupTreeNotAllowed: (p: { tag: string }) =>
    `A ${p.tag} tree is not allowed`,
  markupLimits: () => "Markup exceeds limits",
  markupElementNotAllowed: (p: { tag: string }) =>
    `Element ${p.tag} is not allowed`,
  markupInvalidId: () => "Invalid id",
  markupDuplicateId: (p: { id: string }) => `Duplicate id ${p.id}`,
  markupAttributeNotAllowed: (p: { name: string; tag: string }) =>
    `Attribute ${p.name} is not allowed on ${p.tag}`,
  markupNotFinite: (p: { name: string }) => `${p.name} must be finite`,
  markupNotText: (p: { name: string }) => `${p.name} must be text`,
  markupControlCharacters: (p: { name: string }) =>
    `${p.name} contains control characters`,
  markupHrefSymbol: () => "href must name a symbol in this scene",
  markupLocalReference: (p: { name: string }) =>
    `${p.name} must reference this scene`,
  markupColorOrReference: (p: { name: string }) =>
    `${p.name} must be a color or local reference`,
  markupInvalidAttribute: (p: { name: string }) => `Invalid ${p.name}`,
  markupUrl: (p: { name: string }) => `${p.name} may not contain a URL`,
  unknownControl: (p: { control: string }) => `Unknown control ${p.control}`,
  propertyMustBeNumeric: (p: { property: string }) =>
    `${p.property} must be numeric`,
  invalidProperty: (p: { property: string }) => `Invalid ${p.property}`,
  duplicateNode: (p: { node: string }) => `Duplicate node ${p.node}`,
  definitionCannotContain: (p: { definition: string; kind: string }) =>
    `A ${p.definition} cannot contain ${p.kind} nodes`,
  definitionNodesFixed: (p: { definition: string }) =>
    `Nodes inside a ${p.definition} cannot be manipulated, clipped or masked`,
  equationLabel: (p: { node: string }) =>
    `Equation ${p.node} requires a label as its text alternative`,
  duplicateRegion: (p: { kind: string; id: string }) =>
    `Duplicate ${p.kind} ${p.id}`,
  duplicateSymbol: (p: { symbol: string }) => `Duplicate symbol ${p.symbol}`,
  undefinedClip: (p: { node: string; clip: string }) =>
    `Node ${p.node} references undefined clip ${p.clip}`,
  undefinedMask: (p: { node: string; mask: string }) =>
    `Node ${p.node} references undefined mask ${p.mask}`,
  undefinedSymbol: (p: { node: string; symbol: string }) =>
    `Node ${p.node} references undefined symbol ${p.symbol}`,
  tooManyUses: (p: { limit: number }) => `More than ${p.limit} symbol uses`,
  usesExpandBeyondLimit: () =>
    "Symbol uses expand beyond the rendered node limit",
  unknownLayoutNode: (p: { node: string }) => `Unknown layout node ${p.node}`,
  invalidLayoutProperty: (p: { node: string; property: string }) =>
    `Invalid layout property ${p.node}.${p.property}`,
  invalidTrack: (p: { track: string }) => `Invalid/duplicate track ${p.track}`,
  duplicatePane: (p: { pane: string }) => `Duplicate pane ${p.pane}`,
  paneRowCells: (p: { pane: string }) =>
    `Pane ${p.pane}: every row needs one cell per column`,
  invariantUnknownNode: (p: { node: string }) =>
    `Invariant probes unknown node ${p.node}`,
  invariantUnknownCell: (p: { pane: string }) =>
    `Invariant probes unknown table cell in ${p.pane}`,
  invariantUnknownFormulaValue: (p: { symbol: string }) =>
    `Invariant probes unknown formula value ${p.symbol}`,
  invariantUnknownHighlight: (p: { pane: string }) =>
    `Invariant probes unknown highlight ${p.pane}`,
  duplicateInvariant: (p: { invariant: string }) =>
    `Duplicate invariant ${p.invariant}`,
  invariantTimeOutside: (p: { invariant: string }) =>
    `Invariant ${p.invariant}: time outside duration`,
  goldenLayoutUnknown: (p: { layout: string }) =>
    `Golden layout ${p.layout} is not a layout of this scene`,
  duplicateGolden: (p: { golden: string }) => `Duplicate golden ${p.golden}`,
  unknownStateReference: (p: { state: string }) => `Unknown state ${p.state}`,
  unknownSimulationState: (p: { state: string }) =>
    `Unknown simulation state ${p.state}`,
  reservedIdentifier: () => "Reserved identifier",
  bindingRangeZero: () => "Binding range must be nonzero",
  springTooStiff: () => "Spring is too stiff or too damped for its mass",
  springNeedsEase: () => "spring parameters require ease: spring",
  tooManyStateFields: () => "Too many state fields",
  invalidStateRangeStep: () => "Invalid state range/step",
  duplicateEnumOptions: () => "Duplicate enum options",
  duplicateControls: () => "Duplicate controls",
  invalidScale: () => "Invalid scale",
  sceneNestingExceedsLimit: () => "Scene nesting exceeds limit",
  tooManySceneNodes: () => "Too many scene nodes",
  plotDomainsMustIncrease: () => "Plot domains must increase",
  pathsMustBeginWithM: () => "Paths must begin with M",
  manipulableNeedsLabel: () => "Manipulable nodes require a label",
  emptyManipulation: () => "Empty manipulation",
  dragBindingsRequireNumericState: () => "Drag bindings require numeric state",
  linksCannotTransformOrManipulate: () =>
    "Links cannot transform or manipulate",
  tooManyPathPlotPoints: () => "Too many path/plot points",
  linksNeedNodeTarget: () => "Links must reference a non-link node",
  layoutSetIncomplete: () =>
    "The layout set needs tabletPortrait, tabletLandscape and wide",
  breakpointCompactOnly: () =>
    "breakpoint applies only to the compact/expanded form",
  tooManyTracks: () => "Too many tracks",
  invariantsRequestTooManyChecked: () =>
    "Invariants request too many checked frames",
  goldenTimeOutsideDuration: () => "Golden time outside duration",
  cuesMustBeOrderedWithin: () => "Cues must be ordered within duration",
  reducedMotionFrameIsOutside: () => "Reduced motion frame is outside duration",
  expressionNestingExceedsLimit: () => "Expression nesting exceeds limit",
  equationTooManySymbols: () => "Equation: too many symbols",
  equationUnbalancedBrace: () => "Equation: unbalanced }",
  equationNesting: () => "Equation: nesting exceeds limit",
  equationMissingEnd: () => "Equation: missing \\end",
  equationMissingBrace: () => "Equation: missing }",
  equationAmpersand: () =>
    "Equation: & separates columns only inside a matrix or environment",
  equationDouble: (p: { script: string }) => `Equation: double ${p.script}`,
  equationMissingArgument: () => "Equation: missing argument",
  equationCharacter: (p: { character: string }) =>
    `Equation: unsupported character ${p.character}`,
  equationTrailingBackslash: () => "Equation: trailing backslash",
  equationExpectedBrace: () => "Equation: expected {",
  equationTextContent: () => "Equation: text may not contain braces or macros",
  equationTextTooLong: () => "Equation: text too long",
  equationUnsafeMacro: (p: { name: string }) =>
    `Equation: \\${p.name} is not allowed`,
  equationSqrtIndex: () => "Equation: \\sqrt with an index is not supported",
  equationOperatorName: () => "Equation: operator names are letters only",
  equationRowBreak: (p: { name: string }) =>
    `Equation: \\${p.name} belongs inside \\begin{…} … \\end{…}`,
  equationNeedsDelimiter: (p: { name: string }) =>
    `Equation: \\${p.name} needs a delimiter`,
  equationUnsupportedMacro: (p: { name: string }) =>
    `Equation: unsupported macro \\${p.name}`,
  equationUnsupportedEnvironment: (p: { environment: string }) =>
    `Equation: unsupported environment ${p.environment}`,
  equationTooManyColumns: () => "Equation: too many columns",
  equationTooManyRows: () => "Equation: too many rows",
  equationMismatchedEnd: (p: { environment: string }) =>
    `Equation: \\begin{${p.environment}} ends with another \\end`,
  equationCasesColumns: () => "Equation: cases rows have at most two columns",
});
