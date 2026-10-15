import { createHash } from 'node:crypto';
import { canonicalJson, compileCourse } from '@course-core/sdk/compiler';
import type { CourseManifest } from '@course-core/sdk';
import { fixture } from './fixture.js';

/** Public, domain-neutral teaching-hypothesis fixture on the ordering course.
 * The SDK 0.5 sections (hypotheses, probes, misconception links) are added to
 * the compiled server bundle, the shape an SDK 0.5 compile produces, so Core's
 * runtime is exercised before its SDK dependency moves to 0.5. */
export const HYPOTHESES = [
  { id: 'min-largest', kind: 'misconception', statement: 'You may be choosing the largest value when the question asks for the smallest.', objectiveIds: ['minimum'] },
  { id: 'min-first', kind: 'misconception', statement: 'You may be choosing the first value listed instead of comparing every value.', objectiveIds: ['minimum'] },
  { id: 'max-needs-min', kind: 'missing_prerequisite', statement: 'Finding a maximum may be easier after reviewing how to find a minimum.', objectiveIds: ['maximum'], prerequisiteObjectiveId: 'minimum' },
];
export const PROBES = [{ id: 'min-probe', objectiveId: 'minimum', assessmentId: 'min-probe-item', distinguishes: ['min-largest', 'min-first'],
  signals: [{ hypothesisId: 'min-largest', optionIds: ['nine'] }, { hypothesisId: 'min-first', optionIds: ['four'] }] }];

export function hypothesisSource(options: { placement?: boolean } = {}): CourseManifest {
  const course = fixture();
  if (options.placement === false) delete course.placement;
  course.id = 'ordering-hypotheses';
  course.title = 'Ordering with teaching hypotheses';
  const min = course.chapters[0]!.episodes[0]!;
  min.blocks.push({ id: 'min-practice-check', type: 'assessment', assessmentId: 'min-practice' }, { id: 'min-ambiguous-check', type: 'assessment', assessmentId: 'min-ambiguous' });
  course.assessments.push(
    { id: 'min-practice', type: 'choice', objectiveIds: ['minimum'], familyId: 'practice-three', prompt: 'Which is the smallest of 7, 3 and 9?',
      options: [{ id: 'seven', text: '7' }, { id: 'three', text: '3' }, { id: 'nine', text: '9' }], grading: { correctOptionId: 'three', explanation: '3 is below 7 and 9.' } },
    { id: 'min-ambiguous', type: 'choice', objectiveIds: ['minimum'], familyId: 'practice-ambiguous', prompt: 'Which is the smallest of 8, 6 and 2?',
      options: [{ id: 'eight', text: '8' }, { id: 'six', text: '6' }, { id: 'two', text: '2' }], grading: { correctOptionId: 'two', explanation: '2 is below 6 and 8.' } },
    { id: 'min-again', type: 'choice', objectiveIds: ['minimum'], familyId: 'practice-again', prompt: 'Which is the smallest of 5, 1 and 8?',
      options: [{ id: 'five', text: '5' }, { id: 'one', text: '1' }, { id: 'eight', text: '8' }], grading: { correctOptionId: 'one', explanation: '1 is below 5 and 8.' } },
    { id: 'min-probe-item', type: 'choice', objectiveIds: ['minimum'], familyId: 'diagnostic', prompt: 'Which is the smallest of 4, 9 and 2?',
      options: [{ id: 'four', text: '4' }, { id: 'nine', text: '9' }, { id: 'two', text: '2' }], grading: { correctOptionId: 'two', explanation: '2 is below 4 and 9.' } },
  );
  min.blocks.push({ id: 'min-again-check', type: 'assessment', assessmentId: 'min-again' });
  return course;
}
/** Adds the SDK 0.5 teaching sections to a compiled server bundle. */
export function withTeachingContracts<T extends { assessments: unknown[] }>(server: T): T {
  const bundle = structuredClone(server) as T & { hypotheses?: unknown; probes?: unknown };
  bundle.hypotheses = structuredClone(HYPOTHESES);
  bundle.probes = structuredClone(PROBES);
  const links: Record<string, { item?: string[]; options?: Record<string, string> }> = {
    'min-practice': { options: { nine: 'min-largest', seven: 'min-first' } },
    'min-again': { options: { eight: 'min-largest', five: 'min-first' } },
    'min-ambiguous': { item: ['min-largest', 'min-first'] },
    'min-a': { options: { five: 'min-largest' } },
    'min-probe-item': { item: ['min-largest', 'min-first'] },
  };
  for (const assessment of bundle.assessments as { id: string; role?: string; misconceptionIds?: string[]; options?: { id: string; misconceptionId?: string }[] }[]) {
    const link = links[assessment.id];
    if (!link) continue;
    if (link.item) assessment.misconceptionIds = link.item;
    for (const option of assessment.options ?? []) if (link.options?.[option.id]) option.misconceptionId = link.options[option.id];
    if (assessment.id === 'min-probe-item') assessment.role = 'diagnostic_probe';
  }
  return bundle;
}
export function hypothesisCourse(options: { placement?: boolean } = {}) {
  const compiled = compileCourse(hypothesisSource(options)), server = withTeachingContracts(compiled.server);
  // The release digest covers the whole server bundle, as an SDK 0.5 compile's would.
  return { ...compiled, server, digest: createHash('sha256').update(canonicalJson(server)).digest('hex') };
}
