import { gzipSync } from 'node:zlib';
import { compileCourse } from '@course-core/sdk/compiler';
import { SDK_VERSION } from '@course-core/sdk';
import type { CourseManifest } from '@course-core/sdk';
import { sha256 } from '../src/course-package.js';
import { writeTar, type TarMember } from '../src/ustar.js';

export interface PackageParts {
  manifest?: unknown;
  /** Extra members (listed with the given role unless `unlisted`). */
  extra?: { name: string; bytes: Buffer; role?: string; unlisted?: boolean }[];
  learner?: boolean | unknown;
  registry?: unknown;
  descriptor?: (descriptor: Record<string, unknown>) => void;
  /** Change member bytes after the descriptor was written. */
  tamper?: (members: TarMember[]) => void;
}
/** A synthetic course-package v1 built in-test from a public fixture course. */
export function buildPackage(course: CourseManifest, parts: PackageParts = {}) {
  const manifest = parts.manifest ?? course;
  const compiled = compileCourse(course);
  const members: TarMember[] = [{ name: 'course.json', bytes: Buffer.from(JSON.stringify(manifest)) }];
  const roles: Record<string, string> = { 'course.json': 'course-manifest' };
  if (parts.learner !== false) {
    members.push({ name: 'learner.json', bytes: Buffer.from(JSON.stringify(parts.learner === undefined || parts.learner === true ? compiled.learner : parts.learner)) });
    roles['learner.json'] = 'learner-projection';
  }
  if (parts.registry !== undefined) { members.push({ name: 'adaptation-registry.json', bytes: Buffer.from(JSON.stringify(parts.registry)) }); roles['adaptation-registry.json'] = 'adaptation-registry'; }
  const unlisted = new Set<string>();
  for (const extra of parts.extra ?? []) { members.push({ name: extra.name, bytes: extra.bytes }); if (extra.unlisted) unlisted.add(extra.name); else roles[extra.name] = extra.role ?? 'other'; }
  const descriptor: Record<string, unknown> = {
    format: 'course-package', formatVersion: 1, courseId: compiled.server.id, courseVersion: compiled.server.version, courseDigest: compiled.digest,
    sdkVersion: SDK_VERSION, minimumCoreVersion: '0.1.0', source: { repository: 'https://example.org/synthetic-course', commit: 'a'.repeat(40) },
    members: members.filter(member => !unlisted.has(member.name)).map(member => ({ name: member.name, bytes: member.bytes.length, sha256: sha256(member.bytes), role: roles[member.name] })),
  };
  parts.descriptor?.(descriptor);
  parts.tamper?.(members);
  const files = [{ name: 'course-package.json', bytes: Buffer.from(JSON.stringify(descriptor)) }, ...members];
  const bytes = gzipSync(writeTar(files));
  return { bytes, sha256: sha256(bytes), compiled, descriptor };
}

/** A raw tar header for refusal tests (links, directories, paths the writer would refuse). */
export function rawEntry(name: string, data: Buffer, type = '0', options: { prefix?: string; size?: number } = {}) {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'latin1');
  block.write('0000644\0', 100, 'latin1'); block.write('0000000\0', 108, 'latin1'); block.write('0000000\0', 116, 'latin1');
  block.write((options.size ?? data.length).toString(8).padStart(11, '0') + '\0', 124, 'latin1');
  block.write('00000000000\0', 136, 'latin1'); block.write('        ', 148, 'latin1'); block.write(type, 156, 'latin1');
  if (type === '2' || type === '1') block.write('target', 157, 'latin1');
  block.write('ustar\u000000', 257, 'latin1');
  if (options.prefix) block.write(options.prefix, 345, 155, 'latin1');
  let sum = 0; for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512); data.copy(padded);
  return Buffer.concat([block, padded]);
}
export const rawArchive = (...entries: Buffer[]) => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
