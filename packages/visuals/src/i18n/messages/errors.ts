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
});
