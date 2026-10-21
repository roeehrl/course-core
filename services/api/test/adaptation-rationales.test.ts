import { describe, expect, it } from 'vitest';
import { ADAPTATION_RATIONALES, rationaleView } from '../src/adaptation-rationales.js';

describe('personal-change reasons', () => {
  it('sends a code, not English, for every reason Core writes', () => {
    for (const [code, text] of Object.entries(ADAPTATION_RATIONALES)) expect(rationaleView(text)).toEqual({ whyCode: code, why: '' });
  });
  it('maps reasons stored before codes existed, whatever surrounding whitespace they kept', () => {
    expect(rationaleView('  Course staff inserted an exact author-reviewed remedial episode.\n')).toEqual({ whyCode: 'staff_remedial_episode', why: '' });
  });
  it('keeps free text a trusted pipeline wrote, and never invents a code for it', () => {
    expect(rationaleView('A reviewed note after a missed check.')).toEqual({ whyCode: null, why: 'A reviewed note after a missed check.' });
    expect(rationaleView('Course staff inserted an exact author-reviewed remedial episode. Extra')).toMatchObject({ whyCode: null });
  });
  it('treats a missing or non-text reason as empty', () => {
    expect(rationaleView(undefined)).toEqual({ whyCode: null, why: '' });
    expect(rationaleView(42)).toEqual({ whyCode: null, why: '' });
  });
});
