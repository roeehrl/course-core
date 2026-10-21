/**
 * Randomness and hashing that also work on a non-secure origin.
 *
 * The app can be served over plain http to a non-loopback address (for example a
 * tailnet IP). Browsers treat such a page as a non-secure context and remove
 * `crypto.randomUUID` and `crypto.subtle` there, while `crypto.getRandomValues`
 * stays available. Use these helpers instead of calling those APIs directly; a
 * unit test rejects direct use anywhere else in the app source.
 */

import { AdminError } from "./errors";

const HEX = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, "0"),
);

/** An RFC 4122 version 4 UUID from the platform's cryptographic random source.
 * Never falls back to a non-cryptographic generator. */
export function randomId(): string {
  const source = (globalThis as { crypto?: Crypto }).crypto;
  if (typeof source?.randomUUID === "function") return source.randomUUID();
  if (typeof source?.getRandomValues !== "function")
    throw new AdminError("no_secure_random");
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const h = Array.from(bytes, (b) => HEX[b]!);
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10).join("")}`;
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 in plain JavaScript (FIPS 180-4), for pages where `crypto.subtle` is absent. */
export function sha256Bytes(data: Uint8Array): Uint8Array {
  const length = data.length,
    blocks = Math.ceil((length + 9) / 64);
  const message = new Uint8Array(blocks * 64);
  message.set(data);
  message[length] = 0x80;
  const view = new DataView(message.buffer);
  view.setUint32(message.length - 8, Math.floor(length / 0x20000000));
  view.setUint32(message.length - 4, (length * 8) >>> 0);
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const W = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < message.length; offset += 64) {
    for (let t = 0; t < 16; t++) W[t] = view.getUint32(offset + t * 4);
    for (let t = 16; t < 64; t++) {
      const a = W[t - 15]!,
        b = W[t - 2]!;
      W[t] =
        (W[t - 16]! +
          (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) +
          W[t - 7]! +
          (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) >>>
        0;
    }
    let a = H[0]!,
      b = H[1]!,
      c = H[2]!,
      d = H[3]!,
      e = H[4]!,
      f = H[5]!,
      g = H[6]!,
      h = H[7]!;
    for (let t = 0; t < 64; t++) {
      const t1 =
        (h +
          (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
          ((e & f) ^ (~e & g)) +
          K[t]! +
          W[t]!) >>>
        0;
      const t2 =
        ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) +
          ((a & b) ^ (a & c) ^ (b & c))) >>>
        0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((word, i) => {
      H[i] = (H[i]! + word) >>> 0;
    });
  }
  const out = new Uint8Array(32),
    outView = new DataView(out.buffer);
  H.forEach((word, i) => outView.setUint32(i * 4, word));
  return out;
}

/** Lower-case hex SHA-256 of the UTF-8 text: Web Crypto when the page has it,
 * otherwise the identical plain-JavaScript digest. */
export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  const bytes =
    typeof subtle?.digest === "function"
      ? new Uint8Array(await subtle.digest("SHA-256", data))
      : sha256Bytes(data);
  return Array.from(bytes, (b) => HEX[b]!).join("");
}
