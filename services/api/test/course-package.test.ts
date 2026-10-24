import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { compileCourse } from '@course-core/sdk/compiler';
import { belowMinimumSdk, compareSemver, MINIMUM_SUPPORTED_SDK, COURSE_PACKAGE_LIMITS, isSemver, sha256, verifyCoursePackage } from '../src/course-package.js';
import { readTar, readTarGz, writeTar } from '../src/ustar.js';
import { sdkPackageStatus } from '../src/course-package-routes.js';
import { buildPackage, rawArchive, rawEntry } from './course-package-fixture.js';
import { fixture } from './fixture.js';

const refused = async (bytes: Buffer, code: string) => expect(verifyCoursePackage(bytes)).rejects.toMatchObject({ code });

describe('course-package v1 verifier', () => {
  it('verifies a well-formed package with Core\'s own compiler', async () => {
    const built = buildPackage(fixture(), { extra: [{ name: 'fixture.py', bytes: Buffer.from('print(1)\n'), role: 'host-requirement' }, { name: 'LICENSE', bytes: Buffer.from('Apache-2.0'), role: 'licence' }] });
    const verified = await verifyCoursePackage(built.bytes);
    expect(verified.sha256).toBe(built.sha256);
    expect(verified.descriptor.courseId).toBe('ordering');
    expect(verified.compiled.digest).toBe(compileCourse(fixture()).digest);
    expect(verified.hostRequirements).toEqual([{ name: 'fixture.py', sha256: sha256(Buffer.from('print(1)\n')), bytes: 9 }]);
    expect(verified.adaptationRegistry).toBeNull();
    expect(verified.members.map(member => member.role).sort()).toEqual(['course-manifest', 'host-requirement', 'learner-projection', 'licence']);
  });
  it('accepts a package without the optional learner projection, with a 100-byte name and any-JSON registry', async () => {
    const long = `${'n'.repeat(96)}.txt`;
    const verified = await verifyCoursePackage(buildPackage(fixture(), { learner: false, registry: [1, 2], extra: [{ name: long, bytes: Buffer.from('x') }] }).bytes);
    expect(verified.members.map(member => member.name)).toContain(long);
    expect(verified).toMatchObject({ adaptationRegistryPresent: true, adaptationRegistry: [1, 2] });
  });
  it('refuses a size mismatch, a BOM, non-JSON members and a member listing that is empty', async () => {
    await refused(buildPackage(fixture(), { descriptor: d => { (d.members as { bytes: number }[])[0]!.bytes += 1; } }).bytes, 'PACKAGE_MEMBER_SIZE_MISMATCH');
    await refused(buildPackage(fixture(), { manifest: undefined, tamper: () => undefined, extra: [] , descriptor: d => { d.members = []; } }).bytes, 'PACKAGE_LISTING_INVALID');
    const bom = buildPackage(fixture(), { learner: false, extra: [{ name: 'adaptation-registry.json', bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')]), role: 'adaptation-registry' }] });
    await refused(bom.bytes, 'PACKAGE_MEMBER_NOT_JSON');
    await refused(buildPackage(fixture(), { learner: false, extra: [{ name: 'adaptation-registry.json', bytes: Buffer.from('{not json'), role: 'adaptation-registry' }] }).bytes, 'PACKAGE_MEMBER_NOT_JSON');
    await refused(buildPackage(fixture(), { descriptor: d => { d.sdkVersion = '0.5.0+build.1'; } }).bytes, 'PACKAGE_LISTING_INVALID');
  });
  it('refuses PAX/GNU headers, GNU magic and over-long names', async () => {
    for (const type of ['x', 'g', 'L', 'K']) await refused(rawArchive(rawEntry('entry', Buffer.alloc(0), type)), 'PACKAGE_UNSUPPORTED_ENTRY');
    const gnu = rawEntry('a', Buffer.from('x')); gnu.write('ustar  \0', 257, 'latin1');
    let sum = 0; gnu.write('        ', 148, 'latin1'); for (const byte of gnu.subarray(0, 512)) sum += byte; gnu.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
    await refused(rawArchive(gnu), 'PACKAGE_CORRUPT');
    expect(() => writeTar([{ name: 'n'.repeat(101), bytes: Buffer.alloc(0) }])).toThrow('PACKAGE_INVALID_MEMBER_NAME');
  });
  it('refuses a tampered member (bytes changed after listing)', async () => {
    await refused(buildPackage(fixture(), { tamper: members => { members[0]!.bytes = Buffer.from(members[0]!.bytes.toString().replace('Ordering values', 'Ordering valuez')); } }).bytes, 'PACKAGE_MEMBER_DIGEST_MISMATCH');
  });
  it('refuses an unlisted member', async () => {
    await refused(buildPackage(fixture(), { extra: [{ name: 'hidden.js', bytes: Buffer.from('1'), unlisted: true }] }).bytes, 'PACKAGE_UNLISTED_MEMBER');
  });
  it('refuses a listed member that is missing', async () => {
    await refused(buildPackage(fixture(), { descriptor: d => (d.members as object[]).push({ name: 'gone.json', bytes: 1, sha256: 'b'.repeat(64), role: 'other' }) }).bytes, 'PACKAGE_MISSING_MEMBER');
  });
  it('refuses symlinks and hard links', async () => {
    await refused(rawArchive(rawEntry('course-package.json', Buffer.from('{}')), rawEntry('link', Buffer.alloc(0), '2')), 'PACKAGE_LINK_ENTRY');
    await refused(rawArchive(rawEntry('link', Buffer.alloc(0), '1')), 'PACKAGE_LINK_ENTRY');
  });
  it('refuses directories, devices and GNU long-name records', async () => {
    for (const type of ['5', '3', '4', '6', '7']) await refused(rawArchive(rawEntry('entry', Buffer.alloc(0), type)), 'PACKAGE_UNSUPPORTED_ENTRY');
  });
  it('refuses path traversal, nested and absolute paths', async () => {
    for (const name of ['../course.json', 'dir/course.json', '/etc/passwd', '..']) await refused(rawArchive(rawEntry(name, Buffer.from('x'))), 'PACKAGE_UNSAFE_PATH');
    await refused(rawArchive(rawEntry('course.json', Buffer.from('x'), '0', { prefix: 'nested' })), 'PACKAGE_UNSAFE_PATH');
    await refused(rawArchive(rawEntry('bad name!', Buffer.from('x'))), 'PACKAGE_INVALID_MEMBER_NAME');
  });
  it('refuses oversize members, too many members, oversize totals and oversize compressed input', async () => {
    // A header declaring a 40 MiB member is refused before any data is read.
    await refused(rawArchive(rawEntry('big.bin', Buffer.alloc(0), '0', { size: 40 * 1024 * 1024 })), 'PACKAGE_TOO_LARGE');
    const many = Array.from({ length: COURSE_PACKAGE_LIMITS.maxMembers + 1 }, (_, i) => ({ name: `m${i}`, bytes: Buffer.from('x') }));
    await refused(gzipSync(writeTar(many)), 'PACKAGE_TOO_MANY_MEMBERS');
    const limits = { maxMembers: 10, maxMemberBytes: 1024, maxTotalBytes: 2048 };
    expect(() => readTar(writeTar([{ name: 'a', bytes: Buffer.alloc(1024) }, { name: 'b', bytes: Buffer.alloc(1024) }, { name: 'c', bytes: Buffer.alloc(1) }]), limits)).toThrow('PACKAGE_TOO_LARGE');
    // A decompression bomb stops at the output bound instead of inflating fully.
    await expect(readTarGz(gzipSync(Buffer.alloc(8 * 1024 * 1024)), { ...limits, maxCompressedBytes: 1 << 20 })).rejects.toMatchObject({ code: 'PACKAGE_TOO_LARGE' });
    const huge = Buffer.alloc(COURSE_PACKAGE_LIMITS.maxCompressedBytes + 1); huge[0] = 0x1f; huge[1] = 0x8b;
    await refused(huge, 'PACKAGE_TOO_LARGE');
  });
  it('refuses non-gzip input, corrupt headers, duplicate names and trailing garbage', async () => {
    await refused(Buffer.from('PK\u0003\u0004 not a tarball at all'), 'PACKAGE_NOT_GZIP');
    const entry = rawEntry('a', Buffer.from('x')); entry[0] = 0x62; // checksum no longer matches
    await refused(rawArchive(entry), 'PACKAGE_CORRUPT');
    await refused(rawArchive(rawEntry('a', Buffer.from('x')), rawEntry('a', Buffer.from('y'))), 'PACKAGE_DUPLICATE_MEMBER');
    await refused(gzipSync(Buffer.concat([writeTar([{ name: 'a', bytes: Buffer.from('x') }]), Buffer.alloc(512, 1)])), 'PACKAGE_CORRUPT');
  });
  it('refuses a missing descriptor, unknown keys, an unsupported format and unknown roles', async () => {
    await refused(gzipSync(writeTar([{ name: 'course.json', bytes: Buffer.from('{}') }])), 'PACKAGE_LISTING_MISSING');
    await refused(buildPackage(fixture(), { descriptor: d => { d.signature = 'x'; } }).bytes, 'PACKAGE_UNKNOWN_KEY');
    await refused(buildPackage(fixture(), { descriptor: d => { (d.members as Record<string, unknown>[])[0]!.mode = 420; } }).bytes, 'PACKAGE_UNKNOWN_KEY');
    await refused(buildPackage(fixture(), { descriptor: d => { (d.source as Record<string, unknown>).branch = 'main'; } }).bytes, 'PACKAGE_UNKNOWN_KEY');
    await refused(buildPackage(fixture(), { descriptor: d => { d.formatVersion = 2; } }).bytes, 'PACKAGE_UNSUPPORTED_FORMAT');
    await refused(buildPackage(fixture(), { extra: [{ name: 'run.sh', bytes: Buffer.from('#!/bin/sh'), role: 'executable' }] }).bytes, 'PACKAGE_UNKNOWN_ROLE');
    await refused(buildPackage(fixture(), { descriptor: d => { d.source = { repository: 'http://example.org/x' }; } }).bytes, 'PACKAGE_LISTING_INVALID');
  });
  it('refuses a wrong role assignment (two manifests, none, the descriptor listed)', async () => {
    await refused(buildPackage(fixture(), { extra: [{ name: 'second.json', bytes: Buffer.from(JSON.stringify(fixture())), role: 'course-manifest' }] }).bytes, 'PACKAGE_ROLE_COUNT');
    await refused(buildPackage(fixture(), { descriptor: d => { (d.members as { role: string }[])[0]!.role = 'other'; } }).bytes, 'PACKAGE_ROLE_COUNT');
    await refused(buildPackage(fixture(), { extra: [{ name: 'learner-2.json', bytes: Buffer.from('{}'), role: 'learner-projection' }] }).bytes, 'PACKAGE_ROLE_COUNT');
    await refused(buildPackage(fixture(), { descriptor: d => (d.members as object[]).push({ name: 'course-package.json', bytes: 1, sha256: 'c'.repeat(64), role: 'other' }) }).bytes, 'PACKAGE_LISTING_INVALID');
  });
  it('refuses a compiled wrapper in place of the course manifest', async () => {
    await refused(buildPackage(fixture(), { manifest: compileCourse(fixture()) }).bytes, 'PACKAGE_COMPILED_WRAPPER');
    for (const key of ['formatVersion', 'server', 'learner', 'digest']) await refused(buildPackage(fixture(), { manifest: { ...fixture(), [key]: 1 } }).bytes, 'PACKAGE_COMPILED_WRAPPER');
  });
  it('refuses a digest, identity or learner projection that Core\'s compiler does not reproduce', async () => {
    await refused(buildPackage(fixture(), { descriptor: d => { d.courseDigest = 'd'.repeat(64); } }).bytes, 'PACKAGE_COURSE_DIGEST_MISMATCH');
    await refused(buildPackage(fixture(), { descriptor: d => { d.courseVersion = '9.9.9'; } }).bytes, 'PACKAGE_COURSE_VERSION_MISMATCH');
    await refused(buildPackage(fixture(), { descriptor: d => { d.courseId = 'other'; } }).bytes, 'PACKAGE_COURSE_ID_MISMATCH');
    await refused(buildPackage(fixture(), { learner: { ...compileCourse(fixture()).learner, title: 'Changed' } }).bytes, 'PACKAGE_LEARNER_MISMATCH');
    const invalid = { ...fixture(), objectives: 'none' };
    await expect(verifyCoursePackage(buildPackage(fixture(), { manifest: invalid }).bytes)).rejects.toMatchObject({ code: 'PACKAGE_COURSE_INVALID' });
  });
  it('compares semantic versions by precedence', () => {
    expect(compareSemver('1.2.3', '1.10.0')).toBe(-1);
    expect(compareSemver('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1);
    expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareSemver('2.0.0+build', '2.0.0')).toBe(0);
    expect(isSemver('01.0.0')).toBe(false);
  });
});

describe('which SDK a package may be built with', () => {
  it('refuses a pre-release of the upper bound of the range, as the SDK check does', () => {
    expect(sdkPackageStatus('0.6.4', '0.6.0')).toBe('supported');
    expect(sdkPackageStatus('0.6.5-rc.1', '0.6.0')).toBe('supported');
    expect(sdkPackageStatus('0.7.0-rc.1', '0.6.0')).toBe('unsupported');
    expect(sdkPackageStatus('0.7.0', '0.6.0')).toBe('unsupported');
    expect(sdkPackageStatus('0.5.2', '0.6.0')).toBe('older');
    expect(sdkPackageStatus('1.0.0-rc.1', '0.6.0')).toBe('unsupported');
  });
  it('refuses every package below the minimum supported SDK 0.5.0, whatever SDK Core pins', () => {
    expect(MINIMUM_SUPPORTED_SDK).toBe('0.5.0');
    for (const core of ['0.5.0', '0.6.0']) {
      expect(sdkPackageStatus('0.4.0', core)).toBe('below_minimum');
      expect(sdkPackageStatus('0.4.9', core)).toBe('below_minimum');
      expect(sdkPackageStatus('0.5.0-rc.1', core)).toBe('below_minimum');
      expect(sdkPackageStatus('0.1.0', core)).toBe('below_minimum');
    }
    expect(sdkPackageStatus('0.5.0', '0.5.0')).toBe('supported');
    expect(belowMinimumSdk('0.5.0')).toBe(false);
    expect(belowMinimumSdk('not-a-version')).toBe(true);
  });
});
