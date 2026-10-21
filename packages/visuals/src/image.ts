import { sha256Bytes } from "./digest.js";
import { visualError } from "./errors.js";
import type { ImageAsset } from "./types.js";

/**
 * Embedded raster images (0.5). A scene carries each image as base64 data with its media
 * type, intrinsic size and SHA-256 digest; nothing is fetched. Parsing decodes the data,
 * checks the format's signature against the declared media type and the digest against
 * the bytes, so a scene cannot smuggle markup (SVG, HTML) in as an image, and the digest
 * shown to staff (the debug inspector) is the digest of what renders.
 */
const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const VALUES = new Map([...ALPHABET].map((c, i) => [c, i]));

/** Strict base64 (standard alphabet, padded, no whitespace). Throws IMAGE_INVALID. */
export function decodeBase64(data: string): Uint8Array {
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
    throw visualError("IMAGE_INVALID", "imageNotBase64");
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((data.length / 4) * 3 - padding);
  let o = 0;
  for (let i = 0; i < data.length; i += 4) {
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const c = data[i + k]!;
      n = n * 64 + (c === "=" ? 0 : VALUES.get(c)!);
    }
    for (let k = 2; k >= 0 && o < out.length; k--) {
      const byte = Math.floor(n / 256 ** k) % 256;
      if (o < out.length) out[o++] = byte;
    }
  }
  return out;
}

const startsWith = (bytes: Uint8Array, at: number, signature: number[]) =>
  signature.every((b, i) => bytes[at + i] === b);
/** Whether the bytes carry the signature of the declared media type. */
export function imageSignatureMatches(
  bytes: Uint8Array,
  mediaType: ImageAsset["mediaType"],
): boolean {
  if (mediaType === "image/png")
    return startsWith(
      bytes,
      0,
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    );
  if (mediaType === "image/jpeg")
    return startsWith(bytes, 0, [0xff, 0xd8, 0xff]);
  // RIFF....WEBP
  return (
    startsWith(bytes, 0, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, 8, [0x57, 0x45, 0x42, 0x50])
  );
}

const verified = new Map<string, string>();
/** Checks an image asset's encoding, format signature and digest. Throws VisualError. */
export function verifyImageAsset(image: ImageAsset): void {
  const key = `${image.mediaType}:${image.sha256}:${image.data.length}`;
  if (verified.get(key) === image.data) return;
  const bytes = decodeBase64(image.data);
  if (!imageSignatureMatches(bytes, image.mediaType))
    throw visualError("IMAGE_INVALID", "imageWrongType", {
      image: image.id,
      mediaType: image.mediaType,
    });
  if (`sha256-${sha256Bytes(bytes)}` !== image.sha256)
    throw visualError("IMAGE_DIGEST", "imageDigest", { image: image.id });
  if (verified.size >= 64) verified.delete(verified.keys().next().value!);
  verified.set(key, image.data);
}

/** The data URL an image renders from (only after verifyImageAsset accepted it). */
export const imageHref = (image: ImageAsset) =>
  `data:${image.mediaType};base64,${image.data}`;
