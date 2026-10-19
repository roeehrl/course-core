/**
 * A small, strict reader (and a matching writer) for the tar subset course packages use
 * (course-package v1): top-level regular files only. Nothing is ever written to disk or
 * executed. Only POSIX ustar headers (`ustar\0` + `00`) are read; directories, links, devices,
 * FIFOs, PAX and GNU extension records, a non-empty name prefix, nested or absolute paths and
 * `..` are refused, as are truncated archives and non-zero data after the end-of-archive blocks.
 * Member names therefore fit the 100-byte ustar name field. Error codes are the SDK's
 * course-package codes.
 */
import { gunzip, gzipSync } from 'node:zlib';
import { promisify } from 'node:util';

const unzip = promisify(gunzip);
const BLOCK = 512;

export interface TarLimits { maxMembers: number; maxMemberBytes: number; maxTotalBytes: number }
export interface TarMember { name: string; bytes: Buffer }

/** A refusal with a stable code; never carries archive content. */
export class TarError extends Error {
  constructor(readonly code: string) { super(code); }
}

const fail = (code: string): never => { throw new TarError(code); };
export const MEMBER_NAME = /^[A-Za-z0-9._-]{1,100}$/;

function text(block: Buffer, offset: number, length: number) {
  const field = block.subarray(offset, offset + length), end = field.indexOf(0);
  return field.subarray(0, end === -1 ? length : end).toString('latin1');
}
function octal(block: Buffer, offset: number, length: number) {
  const field = block.subarray(offset, offset + length);
  // Base-256 (high bit) sizes are for > 8 GiB members; never valid here.
  if (field[0]! & 0x80) fail('PACKAGE_CORRUPT');
  const value = field.toString('latin1').replace(/[\0 ]+$/, '').replace(/^ +/, '');
  if (!/^[0-7]{1,12}$/.test(value)) fail('PACKAGE_CORRUPT');
  return Number.parseInt(value, 8);
}
function checksumValid(block: Buffer) {
  const stored = octal(block, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : block[i]!;
  return sum === stored;
}
/** A member name: one top-level file. Anything path-like is a traversal attempt. */
export function checkMemberName(name: string) {
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..' || name.includes('\0')) fail('PACKAGE_UNSAFE_PATH');
  if (!MEMBER_NAME.test(name)) fail('PACKAGE_INVALID_MEMBER_NAME');
}
/** Reads every member of an uncompressed tar archive within the limits. */
export function readTar(archive: Buffer, limits: TarLimits): TarMember[] {
  if (archive.length % BLOCK) fail('PACKAGE_CORRUPT');
  const members: TarMember[] = [], names = new Set<string>();
  let offset = 0, total = 0;
  for (;;) {
    if (offset + BLOCK > archive.length) fail('PACKAGE_CORRUPT');
    const header = archive.subarray(offset, offset + BLOCK);
    if (header.every(byte => byte === 0)) {
      // End of archive: two zero blocks, then only zero padding.
      if (offset + 2 * BLOCK > archive.length || !archive.subarray(offset).every(byte => byte === 0)) fail('PACKAGE_CORRUPT');
      break;
    }
    if (!checksumValid(header)) fail('PACKAGE_CORRUPT');
    const magic = header.subarray(257, 265).toString('latin1');
    if (magic !== 'ustar\u000000') fail('PACKAGE_CORRUPT');
    const type = String.fromCharCode(header[156]!), size = octal(header, 124, 12);
    if (type === '1' || type === '2') fail('PACKAGE_LINK_ENTRY');
    if (type !== '0' && type !== '\0') fail('PACKAGE_UNSUPPORTED_ENTRY');
    if (size > limits.maxMemberBytes) fail('PACKAGE_TOO_LARGE');
    const start = offset + BLOCK, end = start + size;
    if (end > archive.length) fail('PACKAGE_CORRUPT');
    const data = archive.subarray(start, end);
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
    const prefix = text(header, 345, 155), raw = text(header, 0, 100);
    if (prefix) fail('PACKAGE_UNSAFE_PATH');
    const name = raw;
    checkMemberName(name);
    if (names.has(name)) fail('PACKAGE_DUPLICATE_MEMBER');
    names.add(name);
    if (members.length + 1 > limits.maxMembers) fail('PACKAGE_TOO_MANY_MEMBERS');
    total += size;
    if (total > limits.maxTotalBytes) fail('PACKAGE_TOO_LARGE');
    members.push({ name, bytes: Buffer.from(data) });
  }
  return members;
}

/** Decompresses (bounded) and reads a gzip-compressed package archive. */
export async function readTarGz(compressed: Buffer, limits: TarLimits & { maxCompressedBytes: number }) {
  if (compressed.length > limits.maxCompressedBytes) fail('PACKAGE_TOO_LARGE');
  if (compressed.length < 18 || compressed[0] !== 0x1f || compressed[1] !== 0x8b) fail('PACKAGE_NOT_GZIP');
  // Headers, padding and the end-of-archive blocks on top of the member bytes.
  const maxOutputLength = limits.maxTotalBytes + (limits.maxMembers * 3 + 24) * BLOCK;
  let archive: Buffer;
  try { archive = await unzip(compressed, { maxOutputLength }); }
  catch (error) {
    const code = (error as { code?: string }).code;
    throw new TarError(code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError ? 'PACKAGE_TOO_LARGE' : 'PACKAGE_CORRUPT');
  }
  return readTar(archive, limits);
}

function header(name: string, size: number, type = '0') {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, 'latin1');
  block.write('0000644\0', 100, 'latin1');
  block.write('0000000\0', 108, 'latin1');
  block.write('0000000\0', 116, 'latin1');
  block.write(size.toString(8).padStart(11, '0') + '\0', 124, 'latin1');
  block.write('00000000000\0', 136, 'latin1');
  block.write('        ', 148, 'latin1');
  block.write(type, 156, 'latin1');
  block.write('ustar\u000000', 257, 'latin1');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  return block;
}
/** Writes top-level regular files as a deterministic POSIX ustar archive. */
export function writeTar(members: readonly TarMember[]) {
  const parts: Buffer[] = [];
  const pad = (size: number) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);
  for (const member of members) {
    checkMemberName(member.name);
    parts.push(header(member.name, member.bytes.length), member.bytes, pad(member.bytes.length));
  }
  parts.push(Buffer.alloc(2 * BLOCK));
  return Buffer.concat(parts);
}
export const writeTarGz = (members: readonly TarMember[]) => gzipSync(writeTar(members), { level: 9 });
