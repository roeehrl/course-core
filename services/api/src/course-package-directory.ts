/**
 * Host-folder course-package sources. The operator configures the allowed package directories
 * (COURSE_PACKAGE_DIRECTORIES, from the pilot's `coursePackageDirectories`). Administration names
 * one by its id (a digest of the path) and a relative subpath; the host path itself is never sent
 * to or accepted from the browser. Every target is resolved with realpath and must stay inside
 * its directory's realpath, so `..`, absolute subpaths and symlinks that escape are refused.
 *
 * A target is a `*.course.tgz` file, a folder of such files (the newest courseVersion for the
 * course is chosen; several files with that version are listed for a choice), or an unpacked
 * package folder holding `course-package.json`, which is packed deterministically and then
 * verified exactly like an uploaded package (same limits). Nothing in it is executed.
 */
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from './errors.js';
import { compareSemver, COURSE_PACKAGE_LIMITS, CoursePackageError, DESCRIPTOR, parseDescriptor, sha256 } from './course-package.js';
import { checkMemberName, readTarGz, TarError, writeTarGz, type TarMember } from './ustar.js';

export interface PackageDirectory { id: string; name: string; path: string }
const MAX_CANDIDATES = 50;
const refuse = (status: number, code: string, details?: Record<string, unknown>): never => { throw new ApiError(status, code, code, details); };

/** Parses COURSE_PACKAGE_DIRECTORIES (a JSON array of absolute, normalized directories). */
export function packageDirectories(value: string | undefined): PackageDirectory[] {
  if (value === undefined || value === '') return [];
  let list: unknown;
  try { list = JSON.parse(value); } catch { throw new Error('COURSE_PACKAGE_DIRECTORIES must be a JSON array of absolute directories.'); }
  if (!Array.isArray(list) || list.length > 16 || !list.every(item => typeof item === 'string' && item.length < 4096 && path.isAbsolute(item)
    && path.resolve(item) === item && path.parse(item).root !== item && !/[\x00-\x1f]/.test(item)) || new Set(list).size !== list.length)
    throw new Error('COURSE_PACKAGE_DIRECTORIES must be a JSON array of absolute directories.');
  return (list as string[]).map(directory => ({ id: sha256(directory).slice(0, 16), name: path.basename(directory), path: directory }));
}
/** What administration may see of the configured directories. */
export const directoryChoices = (directories: readonly PackageDirectory[]) => directories.map(({ id, name }) => ({ id, name }));

/** A relative subpath: '' (the directory itself) or segments without '.', '..' or separators tricks. */
export function checkSubpath(subpath: string) {
  if (subpath === '') return;
  const segments = subpath.split('/');
  if (subpath.length > 1024 || path.isAbsolute(subpath) || subpath.includes('\\') || subpath.includes('\0')
    || segments.some(segment => segment === '' || segment === '.' || segment === '..' || !/^[A-Za-z0-9 ._+@-]{1,255}$/.test(segment)))
    refuse(400, 'COURSE_PACKAGE_PATH_INVALID');
}
/** Resolves (realpath) a subpath inside one configured directory, refusing anything outside it. */
export async function resolveInside(directories: readonly PackageDirectory[], rootId: string, subpath: string) {
  const directory = directories.find(item => item.id === rootId);
  if (!directory) refuse(404, 'COURSE_PACKAGE_DIRECTORY_UNKNOWN');
  checkSubpath(subpath);
  let root: string, target: string;
  try { root = await realpath(directory!.path); } catch { return refuse(404, 'COURSE_PACKAGE_DIRECTORY_UNAVAILABLE'); }
  try { target = await realpath(path.join(root, subpath)); } catch { return refuse(404, 'COURSE_PACKAGE_PATH_NOT_FOUND'); }
  if (target !== root && !target.startsWith(root + path.sep)) refuse(403, 'COURSE_PACKAGE_PATH_OUTSIDE_DIRECTORY');
  return { root, target, directory: directory! };
}

/** Reads one regular file without following a final symlink, bounded by `limit` bytes. */
async function readRegular(file: string, limit: number, code = 'PACKAGE_TOO_LARGE') {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as { code?: string }).code === 'ELOOP') refuse(422, 'PACKAGE_LINK_ENTRY'); throw error; }
  try {
    const info = await handle.stat();
    if (!info.isFile()) refuse(422, 'PACKAGE_UNSUPPORTED_ENTRY');
    if (info.size > limit) refuse(413, code);
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < info.size) {
      const { bytesRead } = await handle.read(bytes, offset, info.size - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== info.size) refuse(409, 'COURSE_PACKAGE_CHANGED_WHILE_READING');
    return bytes;
  } finally { await handle.close(); }
}

/** Packs an unpacked package folder (top-level regular files only, same limits) into package bytes. */
export async function packFolder(folder: string): Promise<Buffer> {
  const entries = await readdir(folder, { withFileTypes: true });
  if (entries.length > COURSE_PACKAGE_LIMITS.maxMembers) refuse(413, 'PACKAGE_TOO_MANY_MEMBERS');
  const members: TarMember[] = [];
  let total = 0;
  for (const entry of entries.sort((a, b) => (a.name === DESCRIPTOR ? -1 : b.name === DESCRIPTOR ? 1 : a.name < b.name ? -1 : 1))) {
    try { checkMemberName(entry.name); } catch (error) { if (error instanceof TarError) refuse(422, error.code); throw error; }
    if (entry.isSymbolicLink()) refuse(422, 'PACKAGE_LINK_ENTRY', { member: entry.name });
    if (!entry.isFile()) refuse(422, 'PACKAGE_UNSUPPORTED_ENTRY', { member: entry.name });
    const bytes = await readRegular(path.join(folder, entry.name), COURSE_PACKAGE_LIMITS.maxMemberBytes);
    total += bytes.length;
    if (total > COURSE_PACKAGE_LIMITS.maxTotalBytes) refuse(413, 'PACKAGE_TOO_LARGE');
    members.push({ name: entry.name, bytes });
  }
  const packed = writeTarGz(members);
  if (packed.length > COURSE_PACKAGE_LIMITS.maxCompressedBytes) refuse(413, 'PACKAGE_TOO_LARGE');
  return packed;
}

/** The descriptor of a package file, or null when it is not a readable course package. */
async function describe(bytes: Buffer) {
  try {
    const files = await readTarGz(bytes, COURSE_PACKAGE_LIMITS);
    const descriptor = files.find(file => file.name === DESCRIPTOR);
    return descriptor ? parseDescriptor(descriptor.bytes) : null;
  } catch (error) { if (error instanceof TarError || error instanceof CoursePackageError) return null; throw error; }
}

export interface FolderPackage { bytes: Buffer; source: { kind: 'path'; directoryId: string; directory: string; subpath: string; file: string | null } }
/**
 * The package a path source names, for course `courseKey`: a package file, an unpacked package
 * folder, or the newest-version package file for that course in a folder. `file` picks one file
 * of a folder when several share the newest version.
 */
export async function readPathPackage(directories: readonly PackageDirectory[], rootId: string, subpath: string, courseKey: string | null, file?: string): Promise<FolderPackage> {
  const { root, target, directory } = await resolveInside(directories, rootId, subpath);
  const source = (name: string | null) => ({ kind: 'path' as const, directoryId: directory.id, directory: directory.name, subpath, file: name });
  const info = await lstat(target);
  if (info.isFile()) {
    if (!target.endsWith('.course.tgz') && !target.endsWith('.tgz')) refuse(422, 'COURSE_PACKAGE_PATH_NOT_PACKAGE');
    return { bytes: await readRegular(target, COURSE_PACKAGE_LIMITS.maxCompressedBytes), source: source(path.basename(target)) };
  }
  if (!info.isDirectory()) refuse(422, 'PACKAGE_UNSUPPORTED_ENTRY');
  const entries = await readdir(target, { withFileTypes: true });
  if (entries.some(entry => entry.name === DESCRIPTOR)) return { bytes: await packFolder(target), source: source(null) };
  const candidates = entries.filter(entry => entry.isFile() && entry.name.endsWith('.course.tgz')).map(entry => entry.name).sort();
  if (!candidates.length) refuse(404, 'COURSE_PACKAGE_ASSET_NOT_FOUND', { assets: [] });
  if (candidates.length > MAX_CANDIDATES) refuse(413, 'COURSE_PACKAGE_TOO_MANY_CANDIDATES');
  if (file !== undefined) {
    if (!candidates.includes(file)) refuse(404, 'COURSE_PACKAGE_ASSET_NOT_FOUND', { assets: candidates });
    return { bytes: await readRegular(path.join(target, file), COURSE_PACKAGE_LIMITS.maxCompressedBytes), source: source(file) };
  }
  const described: { name: string; bytes: Buffer; version: string; sha: string }[] = [];
  for (const name of candidates) {
    const full = path.join(target, name);
    // Each candidate must itself stay inside the directory (no symlinked files).
    const real = await realpath(full).catch(() => null);
    if (!real || (real !== root && !real.startsWith(root + path.sep))) continue;
    let bytes: Buffer;
    try { bytes = await readRegular(full, COURSE_PACKAGE_LIMITS.maxCompressedBytes); } catch (error) { if (error instanceof ApiError) continue; throw error; }
    const descriptor = await describe(bytes);
    if (descriptor && (courseKey === null || descriptor.courseId === courseKey)) described.push({ name, bytes, version: descriptor.courseVersion, sha: sha256(bytes) });
  }
  if (!described.length) refuse(404, 'COURSE_PACKAGE_ASSET_NOT_FOUND', { assets: candidates });
  described.sort((a, b) => compareSemver(b.version, a.version));
  const newest = described.filter(item => compareSemver(item.version, described[0]!.version) === 0);
  if (new Set(newest.map(item => item.sha)).size > 1) refuse(409, 'COURSE_PACKAGE_ASSET_CHOICE_REQUIRED', { assets: newest.map(item => item.name) });
  return { bytes: newest[0]!.bytes, source: source(newest[0]!.name) };
}
