import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { CompanionCapsule } from '../src/context-capsule.js';
import type { ContextCapsule } from '../src/contracts/context-capsule.js';
import { contextCapsuleJsonSchema, contextCapsuleSchema } from '../src/contracts/context-capsule-schema.js';

// D01: the public ContextCapsule contract is the capsule the server builds, field for field.
const SCHEMA_FILE = fileURLToPath(new URL('../../../docs/contracts/context-capsule.v1.schema.json', import.meta.url));
type WithoutView<T extends { resolvedConstraintSnapshot: object }> = Omit<T, 'resolvedConstraintSnapshot'> & {
  resolvedConstraintSnapshot: Omit<T['resolvedConstraintSnapshot'], 'view'> };

export function sampleCapsule(): ContextCapsule {
  return {
    schemaVersion: 1, kind: 'companion_context_capsule', enrollmentId: 'e1', courseDigest: 'a'.repeat(64), pathRevision: 3, planDigest: null,
    episodeId: 'min', blockId: 'meter-visual', currentStepId: null, activityInstanceId: null, attemptId: null, answersMessageId: null, uiRevision: 7,
    contextRevision: 2, enrollmentRevision: 4, profileRevision: 1, policyRevision: 1, learnerModelRevision: null, recentEventCursor: '12',
    selectedAnchor: { kind: 'visual_node', blockId: 'meter-visual', visualId: 'meter', nodeId: 'bar', label: 'Meter bar', courseDigest: 'a'.repeat(64) },
    simulationState: { blockId: 'meter-visual', visualId: 'meter', settings: [{ key: 'level', label: 'Level', value: 3 }] },
    codeSnapshotHash: null, assessmentMode: 'none', mediaRef: { mediaId: 'walkthrough', blockId: 'min-video', kind: 'youtube', playbackSeconds: 83.3, reviewedSegment: null },
    playbackSeconds: 83.3, reviewedSegment: null, evidenceRefs: [{ evidenceId: 'ev', attemptId: 'at' }],
    historyRefs: [{ messageId: 'm1', role: 'learner', eventId: null, createdAt: '2026-10-21T00:00:00.000Z', characters: 12, clipped: false }],
    summary: null, sourceRefs: [], authorizationScopes: ['episode:min'], extensionAllowanceRefs: [], pendingGateDecisionRef: null,
    resolvedConstraintSnapshot: { digest: 'b'.repeat(64), deadline: null, expansionAllowed: false, independentAssessmentActive: false, policyRevision: 1,
      view: { authority: 'server_resolved_policy_not_model_permission' } },
  };
}

describe('the public ContextCapsule contract', () => {
  it('is the type the server stores: every field, same types (the policy view is open in the contract)', () => {
    expectTypeOf<WithoutView<CompanionCapsule>>().toEqualTypeOf<WithoutView<ContextCapsule>>();
    expectTypeOf<keyof CompanionCapsule>().toEqualTypeOf<keyof ContextCapsule>();
    // A server capsule is always a valid contract capsule.
    expectTypeOf<CompanionCapsule>().toExtend<ContextCapsule>();
  });
  it('the runtime schema accepts a full capsule and readers tolerate added fields', () => {
    expect(contextCapsuleSchema.safeParse(sampleCapsule()).success).toBe(true);
    expect(contextCapsuleSchema.safeParse({ ...sampleCapsule(), futureField: 1 }).success).toBe(true);
    const capsule = sampleCapsule();
    expect(contextCapsuleSchema.safeParse({ ...capsule, resolvedConstraintSnapshot: { ...capsule.resolvedConstraintSnapshot,
      view: { authority: 'server_resolved_policy_not_model_permission', scopeId: 'episode:min', quotas: [] } } }).success).toBe(true);
  });
  it('refuses capsules that break the contract', () => {
    const broken: Record<string, unknown>[] = [
      { ...sampleCapsule(), schemaVersion: 2 },
      { ...sampleCapsule(), kind: 'other' },
      { ...sampleCapsule(), assessmentMode: 'graded' },
      { ...sampleCapsule(), selectedAnchor: { kind: 'visual_node', blockId: 'b' } },
      { ...sampleCapsule(), resolvedConstraintSnapshot: { ...sampleCapsule().resolvedConstraintSnapshot, view: { authority: 'model' } } },
    ];
    const { uiRevision: _, ...missing } = sampleCapsule();
    broken.push(missing);
    for (const capsule of broken) expect(contextCapsuleSchema.safeParse(capsule).success).toBe(false);
  });
  it('the committed JSON Schema is the one generated from the runtime schema', async () => {
    const generated = `${JSON.stringify(contextCapsuleJsonSchema(), null, 2)}\n`;
    if (process.env.UPDATE_CONTRACTS === '1') await writeFile(SCHEMA_FILE, generated);
    expect(await readFile(SCHEMA_FILE, 'utf8')).toBe(generated);
    const schema = JSON.parse(generated);
    expect(schema.properties.schemaVersion).toEqual({ type: 'number', const: 1 });
    expect(schema.required).toEqual(expect.arrayContaining(['selectedAnchor', 'simulationState', 'resolvedConstraintSnapshot', 'mediaRef', 'historyRefs']));
  });
});
