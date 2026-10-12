import type { CourseManifest } from '@course-core/sdk';

/** Public domain-neutral fixture: two separate ordering skills and evidence families. */
export function fixture(): CourseManifest {
  return {
    schemaVersion: 1, id: 'ordering', version: '1.0.0', title: 'Ordering values', summary: 'Learn comparisons.', locale: 'en', platforms: ['web'],
    objectives: [{ id: 'minimum', description: 'Find a minimum.', prerequisites: [], placeable: true }, { id: 'maximum', description: 'Find a maximum.', prerequisites: ['minimum'], placeable: true }],
    chapters: [{ id: 'order', title: 'Order', episodes: [
      { id: 'min', title: 'Minimum', objectiveIds: ['minimum'], gateId: 'min-gate', blocks: [{ id: 'min-text', type: 'text', markdown: 'The minimum is no greater than any other member.' }, { id: 'min-check', type: 'assessment', assessmentId: 'min-a' }] },
      { id: 'max', title: 'Maximum', objectiveIds: ['maximum'], gateId: 'max-gate', blocks: [{ id: 'max-text', type: 'text', markdown: 'The maximum is no less than any other member.' }] },
    ] }],
    assessments: [
      { id: 'min-a', type: 'choice', objectiveIds: ['minimum'], familyId: 'compare', prompt: 'Which is smaller?', options: [{ id: 'two', text: '2' }, { id: 'five', text: '5' }], grading: { correctOptionId: 'two', explanation: '2 is below 5.' } },
      { id: 'min-b', type: 'numeric', objectiveIds: ['minimum'], familyId: 'select', prompt: 'Minimum of 4 and 9?', grading: { expected: 4, absoluteTolerance: 0, explanation: '4 is below 9.' } },
      { id: 'max-a', type: 'numeric', objectiveIds: ['maximum'], familyId: 'compare', prompt: 'Maximum of 4 and 9?', grading: { expected: 9, absoluteTolerance: 0, explanation: '9 is above 4.' } },
      { id: 'max-b', type: 'numeric', objectiveIds: ['maximum'], familyId: 'select', prompt: 'Maximum of -3 and -8?', grading: { expected: -3, absoluteTolerance: 0, explanation: '-3 is above -8.' } },
    ],
    gates: [
      { id: 'min-gate', objectiveIds: ['minimum'], assessmentIds: ['min-a', 'min-b'], minimumIndependentFamilies: 2, requireAllObjectives: true },
      { id: 'max-gate', objectiveIds: ['maximum'], assessmentIds: ['max-a', 'max-b'], minimumIndependentFamilies: 2, requireAllObjectives: true },
    ],
    extensions: [], visuals: [], media: [], sources: [],
    policy: { mode: 'bounded', window: { calendarDays: 30, timeZone: 'UTC', anchor: 'enrollment_started', pauseRule: 'approved_only' }, existingMaterialAccess: 'read_only',
      extensions: { enabled: true, calendarDays: 2, maxGrants: 1, maxDaysPerGrant: 2, learnerAcceptanceRequired: true } },
    placement: { enabled: true, learnerMayDecline: true, objectiveIds: ['minimum', 'maximum'], assessmentIds: ['min-a', 'min-b', 'max-a', 'max-b'], protectedEpisodeIds: [], maxItems: 4 },
  };
}
