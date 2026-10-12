import { createHash } from 'node:crypto';
import type { Assessment } from '@course-core/sdk';
import { DockerSandbox, validateSubmission, type Case } from '@course-core/sandbox';
import { z } from 'zod';
import { ApiError, requireCondition } from './errors.js';
import type { RuntimeExtension } from './publication.js';

const fixtureSchema = z.strictObject({ schemaVersion: z.literal(1), id: z.string().regex(/^[a-z][a-z0-9-]{0,100}$/), version: z.string().regex(/^\d+\.\d+\.\d+$/),
  fixtures: z.array(z.strictObject({ id: z.string().min(1).max(200), language: z.literal('python'), cases: z.array(z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), input: z.unknown(), expected: z.unknown(),
    absoluteTolerance: z.number().finite().min(0).max(0.1).optional(), relativeTolerance: z.number().finite().min(0).max(0.1).optional() })).min(1).max(100) })).min(1).max(50),
});
export interface CodeGrade { passed: boolean; explanation: string; evaluator: string;
  execution: { status: string; sourceDigest: string; durationMs: number; passedCases: number; totalCases: number; runtime: { protocol: 'python-json-v1'; image: string } } }

/** Trusted host-installed data-only fixture registry. It cannot execute course/plugin code. */
export async function codeEvaluator(bytes: Buffer, sandbox: DockerSandbox): Promise<RuntimeExtension> {
  requireCondition(bytes.length <= 1024 * 1024, 'CODE_FIXTURE_ENVELOPE_EXCEEDED');
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new ApiError(400, 'INVALID_CODE_FIXTURE'); }
  const parsed = fixtureSchema.safeParse(value);
  requireCondition(parsed.success, 'INVALID_CODE_FIXTURE');
  const config = parsed.data, integrity = `sha256-${createHash('sha256').update(bytes).digest('hex')}`;
  requireCondition(new Set(config.fixtures.map(fixture => fixture.id)).size === config.fixtures.length, 'DUPLICATE_CODE_FIXTURE');
  for (const fixture of config.fixtures) {
    validateSubmission({ source: 'def solve(x): return x', cases: fixture.cases as Case[] });
    const referenceBytes = fixture.cases.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify({ id: item.id, output: item.expected }).replace(/[^\x00-\x7F]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)) * 2 + 64, 0);
    requireCondition(referenceBytes <= 65536, 'CODE_FIXTURE_OUTPUT_ENVELOPE_EXCEEDED');
  }
  const ready = await sandbox.readiness();
  return { id: config.id, version: config.version, integrity, platforms: ['web'], capabilities: ['assessment.evaluate'], codeReady: ready.ready,
    validateCodeAssessment(assessment) {
      requireCondition(assessment.type === 'code' && assessment.language === 'python' && config.fixtures.some(fixture => fixture.id === assessment.grading.fixtureRef), 'CODE_FIXTURE_NOT_FOUND', 409);
    },
    async evaluateCode(assessment, source) {
      requireCondition(assessment.type === 'code' && assessment.language === 'python', 'CODE_LANGUAGE_UNAVAILABLE', 409);
      const fixture = config.fixtures.find(row => row.id === assessment.grading.fixtureRef);
      requireCondition(fixture, 'CODE_FIXTURE_NOT_FOUND', 409);
      requireCondition(typeof source === 'string' && source.trim().length > 0 && Buffer.byteLength(source) <= 64000, 'INVALID_CODE_SUBMISSION');
      const report = await sandbox.grade({ source, cases: structuredClone(fixture.cases) as Case[] });
      if (['busy', 'unavailable', 'cleanup_failed'].includes(report.status)) throw new ApiError(503, 'CODE_EVALUATOR_UNAVAILABLE');
      const passedCases = report.cases.filter(row => row.passed).length;
      return { passed: report.passed, explanation: report.passed ? `All ${fixture.cases.length} hidden reference cases matched.`
        : report.status === 'graded' ? `${passedCases} of ${fixture.cases.length} reference cases matched. Review the required input/output contract and try a fresh exercise variant.`
          : `The submission did not complete within the ${report.status === 'timeout' ? 'time' : report.status === 'output_limit' ? 'output' : 'execution'} limits. No credit was granted.`,
        evaluator: `${config.id}@${config.version}:${integrity}:${report.runtime.image}`, execution: { status: report.status, sourceDigest: report.sourceDigest, durationMs: report.durationMs, passedCases, totalCases: fixture.cases.length, runtime: report.runtime } };
    },
  };
}

export function qualifiedCodeEvaluator(assessment: Assessment, declarations: { id: string; version: string; integrity: string }[], installed: RuntimeExtension[]) {
  requireCondition(assessment.type === 'code', 'CODE_LANGUAGE_UNAVAILABLE', 409);
  const declaration = declarations.find(row => row.id === assessment.grading.evaluatorId), adapter = installed.find(row => row.id === assessment.grading.evaluatorId);
  requireCondition(declaration && adapter && adapter.version === declaration.version && adapter.integrity === declaration.integrity
    && adapter.codeReady && adapter.evaluateCode && adapter.validateCodeAssessment, 'EVALUATOR_NOT_CONFIGURED', 409);
  adapter.validateCodeAssessment(assessment);
  return adapter.evaluateCode.bind(adapter);
}
