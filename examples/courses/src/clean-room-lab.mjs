// A clean-room course author's source: it imports only the released SDK and uses only what the
// SDK documents and what a Course Core host advertises (GET /api/runtime/extensions). Nothing
// here is copied from or imports Course Core. tests/clean-room.test.mjs enforces that.
import { defineActivity, defineAdminSection, defineCourse, defineEvaluator, defineExtension, validateCourse } from '@course-core/sdk';

/** Host-provided builds this course declares, by their documented ids. */
export const RUNTIME_ID = 'course-core-declarative-activity';
export const CHECKER_ID = 'course-core-declarative-evaluator';
export const EVALUATOR_ID = 'thermometer-reading-check';
export const ACTIVITY_ID = 'thermometer-reading';

/** The advertised build of one host extension (id, version, integrity, platforms). */
function advertised(extensions, id) {
  const build = extensions.find(row => row.id === id && !row.acceptedPriorBuild);
  if (!build) throw new Error(`The host does not advertise ${id}.`);
  return build;
}

const lesson = `A liquid thermometer shows temperature by how far a thin column rises along a printed scale. To read it, first find the size of one small division: count the divisions between two numbered marks and divide the difference between those numbers by the count. On a scale numbered every 5 degrees with ten small divisions between numbers, each division is half a degree.

Read the top of the column with your eye level with it. Looking from above or below shifts the column against the scale and gives a reading that is too high or too low. This is called parallax. If the column stops between two marks, report the nearer mark; on a half-degree scale that keeps the reading within a quarter of a degree.

Finally, decide what the reading means. Water freezes at 0 degrees Celsius, so a reading above zero means ice would melt, and a reading below zero means water would freeze. A negative reading is still read the same way: count the divisions downward from zero.

In the lab below, the column on the pictured thermometer stops three divisions above the 20 mark on a scale numbered every 5 degrees with ten divisions between numbers. Enter the reading, say whether it is above freezing, and confirm you read it at eye level.`;

/**
 * The course. `extensions` is the host's advertised list; `options.withoutKey` leaves out the
 * answer key items (a negative check: Core must refuse to publish it).
 */
export function buildLab(extensions, { version = '1.0.0', withoutKey = false } = {}) {
  const runtime = advertised(extensions, RUNTIME_ID), checker = advertised(extensions, CHECKER_ID);
  const keyItems = [
    { id: `${ACTIVITY_ID}.temperature`, type: 'numeric', objectiveIds: ['read-scale'], familyId: 'lab', prompt: 'Thermometer lab reading',
      grading: { expected: 21.5, absoluteTolerance: 0.25, unit: '°C', explanation: 'Three half-degree divisions above 20 is 21.5.' } },
    { id: `${ACTIVITY_ID}.freezing`, type: 'choice', objectiveIds: ['read-scale'], familyId: 'lab', prompt: 'Thermometer lab freezing check',
      options: [{ id: 'above', text: 'Above freezing' }, { id: 'below', text: 'Below freezing' }], grading: { correctOptionId: 'above', explanation: '21.5 is above 0.' } },
  ];
  const course = defineCourse({
    schemaVersion: 1, id: 'thermometer-lab', version, title: 'Reading a thermometer', summary: 'Read a liquid thermometer scale and decide what the reading means.',
    locale: 'en', platforms: ['web'],
    objectives: [{ id: 'read-scale', description: 'Read a thermometer scale to the nearest division and interpret the reading.', prerequisites: [], placeable: false }],
    chapters: [{ id: 'scales', title: 'Scales', episodes: [{
      id: 'thermometer', title: 'Reading the column', objectiveIds: ['read-scale'], gateId: 'thermometer-gate',
      blocks: [
        { id: 'thermometer-text', type: 'text', markdown: lesson },
        { id: 'thermometer-lab', type: 'activity', activityId: ACTIVITY_ID, configuration: {
          prompt: 'The column stops three small divisions above the 20 mark. Each division is half a degree.',
          controls: [
            { id: 'temperature', label: 'Reading in degrees Celsius', kind: 'number', min: -10, max: 40, step: 0.5 },
            { id: 'freezing', label: 'Compared with freezing', kind: 'choice', options: [{ id: 'above', label: 'Above freezing' }, { id: 'below', label: 'Below freezing' }] },
            { id: 'eye-level', label: 'I read the column at eye level', kind: 'toggle' },
          ],
          submitLabel: 'Check my reading',
        } },
        { id: 'thermometer-check', type: 'assessment', assessmentId: 'division-size' },
      ],
    }] }],
    assessments: [
      { id: 'division-size', type: 'numeric', objectiveIds: ['read-scale'], familyId: 'division', prompt: 'A scale is numbered every 10 degrees with 5 divisions between numbers. How many degrees is one division?',
        grading: { expected: 2, absoluteTolerance: 0, explanation: '10 degrees over 5 divisions is 2 degrees each.' } },
      { id: 'parallax', type: 'choice', objectiveIds: ['read-scale'], familyId: 'parallax', prompt: 'Where should your eye be when you read the column?',
        options: [{ id: 'level', text: 'Level with the top of the column' }, { id: 'above', text: 'Above the column' }], grading: { correctOptionId: 'level', explanation: 'Eye level avoids parallax.' } },
      ...(withoutKey ? [] : keyItems),
    ],
    gates: [{ id: 'thermometer-gate', objectiveIds: ['read-scale'], assessmentIds: ['division-size', 'parallax'], minimumIndependentFamilies: 1, requireAllObjectives: true }],
    extensions: [
      defineExtension({ id: runtime.id, version: runtime.version, integrity: runtime.integrity, execution: 'declarative', entrypoint: 'host/declarative-controls-v1',
        platforms: ['web'], capabilities: ['state.read', 'state.patch', 'observation.emit'],
        accessibility: { keyboard: true, reducedMotion: true, textAlternative: 'Labelled form controls.' } }),
      defineExtension({ id: checker.id, version: checker.version, integrity: checker.integrity, execution: 'server', entrypoint: 'host/declarative-controls-check-v1',
        platforms: ['web'], capabilities: ['assessment.evaluate'], accessibility: { keyboard: true, reducedMotion: true, textAlternative: 'Checks submitted values on the server.' } }),
    ],
    visuals: [], media: [], sources: [],
    policy: { mode: 'bounded', window: { calendarDays: 14, timeZone: 'UTC', anchor: 'enrollment_started', pauseRule: 'never' }, existingMaterialAccess: 'read_only',
      extensions: { enabled: false, calendarDays: 0, maxGrants: 0, maxDaysPerGrant: 0, learnerAcceptanceRequired: true } },
    activities: [defineActivity({
      id: ACTIVITY_ID, version: '1.0.0', title: 'Thermometer lab', objectiveIds: ['read-scale'],
      supportedTargets: ['web_desktop', 'web_mobile'],
      rendererRefs: [{ target: 'web_desktop', rendererId: RUNTIME_ID }, { target: 'web_mobile', rendererId: RUNTIME_ID }],
      executionAdapter: 'declarative',
      capabilityRequirements: [{ capability: 'state.read', required: true }, { capability: 'state.patch', required: true }, { capability: 'observation.emit', required: true }],
      equivalentFallbacks: [], offlineBehavior: 'unavailable',
      resourceBudget: { timeoutMs: 5000, maxMemoryMb: 32, maxStateBytes: 2048, maxEventBytes: 1024, maxEventsPerMinute: 10 },
      accessibleSemantics: { keyboard: true, screenReader: true, reducedMotion: true, nonPointerPath: true, textAlternative: 'Enter the reading, choose above or below freezing and confirm the eye-level check.' },
      stateMigration: { stateVersion: 1, strategy: 'none', migratesFrom: [] },
      layoutInputs: ['effective_window_bounds', 'font_scale'], layouts: { compact: { columns: 1 }, expanded: { columns: 2 } },
      evaluatorRef: EVALUATOR_ID,
    })],
    evaluators: [defineEvaluator({
      id: EVALUATOR_ID, version: '1.0.0', extensionId: CHECKER_ID, method: 'deterministic', itemTypes: ['numeric', 'choice'], humanConfirmation: 'none',
      outputs: { uncertainty: true, provenance: true }, tests: { fixtureRef: 'tests/clean-room.test.mjs', acceptsValidVariants: true, rejectsMisconceptions: true },
    })],
    adminSections: [defineAdminSection({
      id: EVALUATOR_ID, version: '1.0.0', title: 'Lab feedback', description: 'What a learner is told after a reading that does not match.',
      requiredPermissions: ['course.read', 'course.settings.write'], learnerDataAccess: 'none', audit: 'all_mutations',
      settings: [{ id: 'show-mismatched-controls', label: 'Name the values that were off', description: 'When on, a learner whose reading does not match is told which values to look at again.',
        scope: 'enrollment', mutationPermission: 'course.settings.write', type: 'boolean', default: false }],
    })],
  });
  const result = validateCourse(course);
  if (!result.valid) throw new Error(`The lab course is invalid: ${JSON.stringify(result.issues)}`);
  return course;
}
