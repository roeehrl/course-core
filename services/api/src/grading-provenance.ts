import { createHash } from 'node:crypto';
import type { Assessment, CourseManifest } from '@course-core/sdk';
import { digestJson } from './repository.js';
import { DETERMINISTIC_GRADER_SOURCE } from './learning.js';
import { codeView, findAssessment, reviewedRubric } from './gates.js';
import { rubricDigest } from './rubric-evaluator.js';
import type { RuntimeExtension } from './publication.js';

/**
 * What one grading was bound to (M03), so a later reader can tell exactly which item, key and
 * evaluator produced a result, and whether any of them changed since:
 * - itemDigest: the whole item as the course release declares it;
 * - answerKeyDigest: what decides right and wrong: a deterministic item's key (without its
 *   explanation, which only teaches), a code item's grading reference plus the evaluator build
 *   that holds its hidden cases, or a reviewed item's rubric;
 * - evaluatorDigest: the code that graded: Core's own deterministic graders (a hash of their
 *   deployed source), or the installed extension build (id, version, integrity);
 * - codeImage: the sandbox image a code answer ran in, as the sandbox reported it.
 * Each digest is SHA-256 of canonical JSON.
 */
export interface GradingProvenance { itemDigest: string; answerKeyDigest: string; evaluatorDigest: string; codeImage: string | null }

/** Core's deterministic graders as deployed. A changed grader changes every new binding. */
export const DETERMINISTIC_GRADER_DIGEST = createHash('sha256').update(DETERMINISTIC_GRADER_SOURCE).digest('hex');

type Build = Pick<RuntimeExtension, 'id' | 'version' | 'integrity'>;
const buildDigest = (build: Build | undefined, fallbackId: string) =>
  digestJson({ kind: 'extension', id: build?.id ?? fallbackId, version: build?.version ?? null, integrity: build?.integrity ?? null });
/** The installed build that serves an extension ID, else the course's declaration of it. */
function buildOf(course: CourseManifest, id: string, installed: readonly RuntimeExtension[]): Build | undefined {
  return installed.find(e => e.id === id) ?? course.extensions.find(e => e.id === id);
}
/** A deterministic key without its teaching explanation. */
function deterministicKey(assessment: Assessment) {
  const { explanation: _explanation, ...key } = assessment.grading as Record<string, unknown>;
  return key;
}

export function gradingProvenance(course: CourseManifest, assessmentId: string, installed: readonly RuntimeExtension[] = [],
  grade?: { execution?: { runtime?: { image?: string } } }): GradingProvenance {
  const assessment = findAssessment(course, assessmentId);
  if (!assessment) throw new Error(`Unknown assessment ${assessmentId}`);
  const itemDigest = digestJson(assessment);
  const rubric = reviewedRubric(course, assessment.id);
  if (rubric) {
    return { itemDigest, answerKeyDigest: rubricDigest(rubric), evaluatorDigest: buildDigest(buildOf(course, rubric.evaluatorExtensionId, installed), rubric.evaluatorExtensionId), codeImage: null };
  }
  const code = codeView(course, assessment);
  if (code) {
    const build = buildOf(course, code.grading.evaluatorId, installed);
    return { itemDigest, answerKeyDigest: digestJson({ grading: code.grading, casesIn: build?.integrity ?? null }), evaluatorDigest: buildDigest(build, code.grading.evaluatorId),
      codeImage: grade?.execution?.runtime?.image?.slice(0, 300) || null };
  }
  return { itemDigest, answerKeyDigest: digestJson(deterministicKey(assessment)), evaluatorDigest: digestJson({ kind: 'core', grader: DETERMINISTIC_GRADER_DIGEST }), codeImage: null };
}
/** Column values for attempts and attempt_regrades, in this order. */
export const provenanceColumns = (p: GradingProvenance) => [p.itemDigest, p.answerKeyDigest, p.evaluatorDigest, p.codeImage];

/** Which parts of an attempt's grading binding differ from the item as the course declares it now. */
export function provenanceChanges(stored: { item_digest: string | null; answer_key_digest: string | null; evaluator_digest: string | null }, current: GradingProvenance) {
  if (!stored.item_digest) return null;
  return { item: stored.item_digest !== current.itemDigest, answerKey: stored.answer_key_digest !== current.answerKeyDigest, evaluator: stored.evaluator_digest !== current.evaluatorDigest };
}
