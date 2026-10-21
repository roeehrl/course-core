import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RELEASE_CHECK_CODES, STAFF_MESSAGE_CODES, staffMessage } from '../src/staff-messages.js';
import { STUDY_WARNING_CODES } from '../src/study.js';

// The API sends staff codes, never sentences (docs/i18n.md). Each code it can send must have an
// English and a Hebrew message in the admin app, or staff would see a bare code.
const catalog = (locale: 'en' | 'he', namespace: string) =>
  JSON.parse(readFileSync(new URL(`../../../apps/admin/src/i18n/messages/${locale}/${namespace}.json`, import.meta.url), 'utf8')) as Record<string, string>;
const researchCodes = [...readFileSync(new URL('../../../packages/research/src/errors.ts', import.meta.url), 'utf8')
  .split('export class')[0]!.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!);

describe('staff codes have admin messages in every locale', () => {
  const cases: [string, string, readonly string[], (code: string) => string[]][] = [
    ['command outcomes', 'serverMessages', STAFF_MESSAGE_CODES, (c) => [`code.${c}`]],
    ['release checks', 'releaseChecks', RELEASE_CHECK_CODES, (c) => [`code.${c}.label`, `code.${c}.detail`]],
    ['study warnings', 'studies', STUDY_WARNING_CODES, (c) => [`warning.${c}`]],
    ['research inspection failures', 'researchView', researchCodes, (c) => [`failure.${c}`]],
    ['course package problems', 'installCourse', ['SDK_UNSUPPORTED', 'SDK_OLDER_THAN_CORE', 'CORE_VERSION_TOO_OLD',
      'RELEASE_VERSION_CONFLICT', 'OLDER_THAN_INSTALLED', 'HOST_REQUIREMENT_MISSING', 'HOST_REQUIREMENT_DIFFERENT', 'ADAPTATION_REGISTRY_NOT_APPROVABLE', 'COURSE_SUPPLIED_UNAVAILABLE', 'COURSE_SUPPLIED_APPROVAL_REQUIRED', 'runtime'],
    (c) => [`problem.${c}`]],
  ];
  for (const [name, namespace, codes, keys] of cases)
    it(name, () => {
      expect(codes.length).toBeGreaterThan(0);
      for (const locale of ['en', 'he'] as const) {
        const messages = catalog(locale, namespace);
        const missing = codes.flatMap(keys).filter((key) => typeof messages[key] !== 'string');
        expect(missing, `${locale}/${namespace}.json`).toEqual([]);
      }
    });
  it('research codes were read from the error type', () => expect(researchCodes).toContain('URL_REJECTED'));
  it('a staff message is a code with values, never a sentence', () => {
    expect(staffMessage('RELEASE_ARCHIVED', { learners: 2 })).toEqual({ code: 'RELEASE_ARCHIVED', params: { learners: 2 } });
    expect(staffMessage('COURSE_SAVED')).toEqual({ code: 'COURSE_SAVED' });
    for (const code of [...STAFF_MESSAGE_CODES, ...RELEASE_CHECK_CODES, ...STUDY_WARNING_CODES]) expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
  });
});
