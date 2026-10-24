import { createHash } from 'node:crypto';
import { answerMessage, type AnswerMessage } from './answer-messages.js';
import type { Assessment,CourseManifest } from '@course-core/sdk';
import { type DockerSandbox, validateSubmission, type Case } from '@course-core/sandbox';
import { z } from 'zod';
import { canonicalJson } from '@course-core/sdk/compiler';
import { ApiError, requireCondition } from './errors.js';
import type { RuntimeExtension } from './publication.js';

/** The part of the grading sandbox the evaluator uses. */
export type CodeSandbox = Pick<DockerSandbox, 'readiness' | 'grade'>;

const fixtureSchema = z.strictObject({ schemaVersion: z.literal(1), id: z.string().regex(/^[a-z][a-z0-9-]{0,100}$/), version: z.string().regex(/^\d+\.\d+\.\d+$/),
  fixtures: z.array(z.strictObject({ id: z.string().min(1).max(200), language: z.literal('python'), cases: z.array(z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), input: z.unknown(), expected: z.unknown(),
    absoluteTolerance: z.number().finite().min(0).max(0.1).optional(), relativeTolerance: z.number().finite().min(0).max(0.1).optional() })).min(1).max(100) })).min(1).max(50),
});
/** `message` is Core's own coded feedback; an extension evaluator may instead send its own `explanation`. */
export interface CodeGrade { passed: boolean; explanation?: string; message?: AnswerMessage; evaluator: string;
  execution: { status: string; sourceDigest: string; durationMs: number; passedCases: number; totalCases: number; outputBytes?:number; batchesCompleted?:number; runtime: { protocol: 'python-json-v1'; image: string } } }

/** Partition conservative reference envelopes without omitting/reordering a case.
 * The broker enforces the SAME whole-attempt output/time/admission budget across
 * batches; the estimate is never permission to increase those execution limits. */
export function codeFixtureBatchPlan(cases:Case[],limit=65536){
  const counts:number[]=[];let count=0,estimated=0,minimum=0;
  for(const item of cases){
    const bytes=Buffer.byteLength(JSON.stringify({id:item.id,output:item.expected}).replace(/[^\x00-\x7F]/g,c=>`\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`))+1;
    const conservative=bytes*2+64;requireCondition(conservative<=limit,'CODE_FIXTURE_OUTPUT_ENVELOPE_EXCEEDED');minimum+=bytes;
    if(count&&estimated+conservative>limit){counts.push(count);count=0;estimated=0;}
    count++;estimated+=conservative;
  }
  if(count)counts.push(count);requireCondition(minimum<=limit&&counts.length<=8,'CODE_FIXTURE_OUTPUT_ENVELOPE_EXCEEDED');return counts;
}

/** Trusted host-installed data-only fixture registry. It cannot execute course/plugin code. */
export async function codeEvaluator(bytes: Buffer, sandbox: CodeSandbox): Promise<RuntimeExtension> {
  requireCondition(bytes.length <= 1024 * 1024, 'CODE_FIXTURE_ENVELOPE_EXCEEDED');
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new ApiError(400, 'INVALID_CODE_FIXTURE'); }
  const parsed = fixtureSchema.safeParse(value);
  requireCondition(parsed.success, 'INVALID_CODE_FIXTURE');
  const config = parsed.data, integrity = `sha256-${createHash('sha256').update(bytes).digest('hex')}`;
  requireCondition(new Set(config.fixtures.map(fixture => fixture.id)).size === config.fixtures.length, 'DUPLICATE_CODE_FIXTURE');
  for (const fixture of config.fixtures) {
    validateSubmission({ source: 'def solve(x): return x', cases: fixture.cases as Case[] });
    codeFixtureBatchPlan(fixture.cases as Case[]);
  }
  const ready = await sandbox.readiness();
  const grade = async (fixtureCases: Case[], source: unknown): Promise<CodeGrade> => {
    requireCondition(typeof source === 'string' && source.trim().length > 0 && Buffer.byteLength(source) <= 64000, 'INVALID_CODE_SUBMISSION');
    const cases = structuredClone(fixtureCases), report = await sandbox.grade({ source, cases, batchCaseCounts: codeFixtureBatchPlan(cases) });
    if (['busy', 'unavailable', 'cleanup_failed'].includes(report.status)) throw new ApiError(503, 'CODE_EVALUATOR_UNAVAILABLE');
    const passedCases = report.cases.filter(row => row.passed).length;
    return { passed: report.passed, message: report.passed ? answerMessage('code_all_matched', { total: cases.length })
      : report.status === 'graded' ? answerMessage('code_some_matched', { passed: passedCases, total: cases.length })
        : answerMessage('code_limit', { limit: report.status === 'timeout' ? 'time' : report.status === 'output_limit' ? 'output' : 'execution' }),
      evaluator: `${config.id}@${config.version}:${integrity}:${report.runtime.image}`, execution: { status: report.status, sourceDigest: report.sourceDigest, durationMs: report.durationMs, passedCases, totalCases: cases.length, outputBytes:report.outputBytes,batchesCompleted:report.batchesCompleted,runtime: report.runtime } };
  };
  return { id: config.id, version: config.version, integrity, platforms: ['web'], capabilities: ['assessment.evaluate'], codeReady: ready.ready,
    validateCodeAssessment(assessment) {
      requireCondition(assessment.type === 'code' && assessment.language === 'python' && config.fixtures.some(fixture => fixture.id === assessment.grading.fixtureRef), 'CODE_FIXTURE_NOT_FOUND', 409);
    },
    async evaluateCode(assessment, source) {
      requireCondition(assessment.type === 'code' && assessment.language === 'python', 'CODE_LANGUAGE_UNAVAILABLE', 409);
      const fixture = config.fixtures.find(row => row.id === assessment.grading.fixtureRef);
      requireCondition(fixture, 'CODE_FIXTURE_NOT_FOUND', 409);
      return grade(fixture.cases as Case[], source);
    },
    // Hidden tests of a supervisor-generated exercise (generated-content.ts): the same sandbox,
    // limits and result shape, with cases the host verified and stored with the exercise.
    async evaluateGeneratedCode(assessment, cases, source) {
      requireCondition(assessment.type === 'code' && assessment.language === 'python' && isGeneratedFixtureRef(assessment.grading.fixtureRef)
        && assessment.grading.fixtureRef === generatedFixtureRef(cases), 'CODE_FIXTURE_NOT_FOUND', 409);
      try { validateSubmission({ source: 'def solve(x): return x', cases }); codeFixtureBatchPlan(cases); }
      catch { throw new ApiError(409, 'CODE_FIXTURE_NOT_FOUND'); }
      return grade(cases, source);
    },
  };
}

/** A generated exercise names its hidden tests by their digest; nothing else can match it. */
export const generatedFixtureRef = (cases: readonly Case[]) => 'generated-' + createHash('sha256').update(canonicalJson(cases)).digest('hex');
export const isGeneratedFixtureRef = (ref: string) => /^generated-[a-f0-9]{64}$/.test(ref);
/** The installed evaluator of a generated exercise: the canonical item's evaluator, as
 * qualifiedCodeEvaluator requires it, offering hidden tests of generated exercises. */
export function qualifiedGeneratedCodeEvaluator(assessment: Assessment, declarations: CourseManifest['extensions'], installed: readonly RuntimeExtension[]) {
  requireCondition(assessment.type === 'code' && isGeneratedFixtureRef(assessment.grading.fixtureRef), 'CODE_LANGUAGE_UNAVAILABLE', 409);
  const declaration = declarations.find(row => row.id === assessment.grading.evaluatorId), adapter = installed.find(row => row.id === assessment.grading.evaluatorId);
  requireCondition(declaration && adapter && adapter.version === declaration.version && adapter.integrity === declaration.integrity
    && declaration.capabilities.includes('assessment.evaluate') && adapter.capabilities.includes('assessment.evaluate')
    && declaration.platforms.includes('web') && adapter.platforms.includes('web')
    && adapter.codeReady && adapter.evaluateGeneratedCode, 'EVALUATOR_NOT_CONFIGURED', 409);
  return adapter.evaluateGeneratedCode.bind(adapter);
}

// This identity check deliberately stays inline instead of calling the shared
// declarationMatchesInstalled helper (extension-identity.ts). The compiled source
// text of this function is hashed into the authored-code-bank-v1 adapter's
// implementationDigest (adaptation-store.ts), and approved adaptation registries pin
// that digest. Core 0.1.33 swapped in the helper, which changed the digest and
// stopped every approved code-bank profile from resolving. The behaviour is the same
// either way: code evaluators never carry acceptedPriorBuilds, so the helper reduces
// to this exact (version, integrity) comparison. Keep the body byte-identical; the
// built digest is checked against services/api/adapter-digests.json.
export function qualifiedCodeEvaluator(assessment: Assessment, declarations: CourseManifest['extensions'], installed: RuntimeExtension[]) {
  requireCondition(assessment.type === 'code', 'CODE_LANGUAGE_UNAVAILABLE', 409);
  const declaration = declarations.find(row => row.id === assessment.grading.evaluatorId), adapter = installed.find(row => row.id === assessment.grading.evaluatorId);
  requireCondition(declaration && adapter && adapter.version === declaration.version && adapter.integrity === declaration.integrity
    && declaration.capabilities.includes('assessment.evaluate') && adapter.capabilities.includes('assessment.evaluate')
    && declaration.platforms.includes('web') && adapter.platforms.includes('web')
    && adapter.codeReady && adapter.evaluateCode && adapter.validateCodeAssessment, 'EVALUATOR_NOT_CONFIGURED', 409);
  adapter.validateCodeAssessment(assessment);
  return adapter.evaluateCode.bind(adapter);
}
