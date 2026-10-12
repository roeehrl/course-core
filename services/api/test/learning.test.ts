import { describe, expect, it } from 'vitest';
import { gateDecision, gradeDeterministic, learningSnapshot, publicQuestion, type EvidenceRow } from '../src/learning.js';
import { fixture } from './fixture.js';

const evidence = (objective: string, assessment: string, family: string, changes: Partial<EvidenceRow> = {}): EvidenceRow => ({
  id: `${assessment}-evidence`, objective_id: objective, assessment_id: assessment, family_id: family,
  independent: true, course_digest: 'digest', result: { passed: true }, ...changes,
});

describe('honest evidence and progression', () => {
  it('requires distinct independent families for every required objective', () => {
    const gate = { ...fixture().gates[0]!, objectiveIds: ['minimum', 'maximum'] };
    const minEvidence = [evidence('minimum', 'min-a', 'compare'), evidence('minimum', 'min-b', 'select')];
    expect(gateDecision(gate, minEvidence, 'digest').passed).toBe(false);
    expect(gateDecision({ ...gate, requireAllObjectives: false }, minEvidence, 'digest').passed).toBe(true);
    expect(gateDecision(fixture().gates[0]!, [minEvidence[0]!, { ...minEvidence[0]!, id: 'another' }], 'digest').passed).toBe(false);
  });
  it('rejects stale, failed, assisted, and unrelated evidence separately', () => {
    const a = evidence('minimum', 'min-a', 'compare'), b = evidence('minimum', 'min-b', 'select');
    for (const bad of [{ ...b, independent: false }, { ...b, course_digest: 'old' }, { ...b, result: { passed: false } }, { ...b, assessment_id: 'not-in-bank' }]) {
      expect(gateDecision(fixture().gates[0]!, [a, bad], 'digest').passed).toBe(false);
    }
    expect(gateDecision(fixture().gates[0]!, [a, b], 'digest').passed).toBe(true);
  });
  it('revoking evidence relocks descendants despite retained coverage records', () => {
    const progress = [ { episode_id: 'min', state: 'completed' as const, completed_block_ids: ['min-text'], evidence_refs: [] }, { episode_id: 'max', state: 'completed' as const, completed_block_ids: [], evidence_refs: [] } ];
    const snapshot = learningSnapshot(fixture(), 'digest', progress, []);
    expect(snapshot.lessons.map(row => row.status)).toEqual(['available', 'locked']);
    expect(snapshot.complete).toBe(false);
  });
  it('never confuses numeric strings, nonfinite numbers, or an option label with a valid answer', () => {
    const [choice, numeric] = fixture().assessments;
    for (const value of ['4', null, NaN, Infinity, {}, [4]]) expect(() => gradeDeterministic(numeric!, value)).toThrow();
    expect(() => gradeDeterministic(choice!, '2')).toThrow();
    expect(gradeDeterministic(numeric!, 4).passed).toBe(true);
    expect(gradeDeterministic(numeric!, 4.00001).passed).toBe(false);
    expect(gradeDeterministic(choice!, 'five').passed).toBe(false);
  });
  it('serves prompts without grading rules or independence family identifiers', () => {
    expect(publicQuestion(fixture().assessments[0]!)).not.toHaveProperty('grading');
    expect(publicQuestion(fixture().assessments[0]!)).not.toHaveProperty('familyId');
    expect(publicQuestion(fixture().assessments[0]!)).toHaveProperty('options');
  });
  it('skips optional units in the required path without inventing credit or removing prerequisite gates', () => {
    const course = fixture();
    course.objectives.push({ id: 'optional-topic', description: 'An optional enrichment.', prerequisites: [] });
    course.chapters[0]!.episodes.unshift({ id: 'enrichment', title: 'Optional enrichment', requirement: 'optional', objectiveIds: ['optional-topic'], blocks: [{ id: 'optional-read', type: 'text', markdown: 'An enrichment.' }] });
    const first = learningSnapshot(course, 'digest', [], []);
    expect(first.nextEpisodeId).toBe('min');
    expect(first.lessons.map(row => row.status)).toEqual(['available', 'available', 'locked']);
    const progress = ['min', 'max'].map(id => ({ episode_id: id, state: 'completed' as const, completed_block_ids: [`${id}-text`], evidence_refs: [] }));
    const rows = [evidence('minimum', 'min-a', 'compare'), evidence('minimum', 'min-b', 'select'), evidence('maximum', 'max-a', 'compare'), evidence('maximum', 'max-b', 'select')];
    const finished = learningSnapshot(course, 'digest', progress, rows);
    expect(finished.complete).toBe(true); expect(finished.nextEpisodeId).toBeNull();
    expect(finished.lessons[0]!.status).toBe('available'); expect(finished.lessons[0]!.completedBlockIds).toEqual([]);
  });
});
