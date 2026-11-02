import { describe, expect, it } from 'vitest';
import { extensionCompatibility } from '../src/platform-operations.js';

const digest = 'a'.repeat(64), other = 'b'.repeat(64);
const creator = { id: 'course-numeric-creator', version: '1.0.0', integrity: `sha256-${digest}`, execution: 'server' };
const generators = [{ id: 'bounded-numeric-v1', implementationDigest: digest }];

describe('course extension compatibility on the integrations page', () => {
  it('counts a server extension served by a trusted recovery generator of the same digest as installed', () => {
    expect(extensionCompatibility(creator, [], generators)).toEqual({ id: 'course-numeric-creator', version: '1.0.0', execution: 'server',
      status: 'compatible', servedByPriorBuild: false, servedByGenerator: 'bounded-numeric-v1' });
  });

  it('still reports a missing extension when no generator has its integrity', () => {
    expect(extensionCompatibility(creator, [], [{ id: 'bounded-numeric-v1', implementationDigest: other }])).toMatchObject({ status: 'missing', servedByGenerator: null });
    expect(extensionCompatibility(creator, [])).toMatchObject({ status: 'missing', servedByGenerator: null });
    // A generator serves only server extensions; a browser one with the same bytes is not satisfied by it.
    expect(extensionCompatibility({ ...creator, execution: 'browser' }, [], generators)).toMatchObject({ status: 'missing', servedByGenerator: null });
  });

  it('prefers an exact installed build, and keeps version mismatches and built-in declarative extensions', () => {
    const installed = [{ id: creator.id, version: '1.0.0', integrity: creator.integrity, prior: true }];
    expect(extensionCompatibility(creator, installed, generators)).toMatchObject({ status: 'compatible', servedByPriorBuild: true, servedByGenerator: null });
    expect(extensionCompatibility({ ...creator, integrity: `sha256-${other}` }, installed, generators)).toMatchObject({ status: 'version_mismatch' });
    expect(extensionCompatibility({ ...creator, execution: 'declarative' }, [], [])).toMatchObject({ status: 'built_in' });
  });
});
