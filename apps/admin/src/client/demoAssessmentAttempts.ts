// i18n-ignore-file: fictional demo check titles, shown as course content
import type { AdminClient } from "../domain/contracts";
import type { AssessmentAttempts } from "../domain/assessmentAttempts";
import { AdminError } from "../domain/errors";

/** The demo's assessment policy and one fictional learner's use per check. Grants are kept in
 * memory per enrollment; the server version records each one with its reason. */
export const DEMO_ASSESSMENT_POLICY = {
  maxGradedAttemptsPerCheck: 3,
  retryCooldownMinutes: 30,
};
export function createDemoAssessmentAttempts({
  revisionOf,
  permitGrant,
}: {
  /** The enrollment revision the demo policy client currently reports. */
  revisionOf: (enrollmentId: string) => Promise<number>;
  /** Throws unless the demo role may change policy for this enrollment. */
  permitGrant: (enrollmentId: string) => void;
}): Pick<AdminClient, "getAssessmentAttempts" | "grantAssessmentAttempt"> {
  const granted = new Map<string, Map<string, number>>();
  const receipts = new Map<string, AssessmentAttempts>();
  let sequence = 0;
  async function view(
    enrollmentId: string,
    revision?: number,
  ): Promise<AssessmentAttempts> {
    const grants = granted.get(enrollmentId) ?? new Map<string, number>();
    const limit = (checkId: string) =>
      DEMO_ASSESSMENT_POLICY.maxGradedAttemptsPerCheck +
      (grants.get(checkId) ?? 0);
    return {
      enrollmentId,
      revision: revision ?? (await revisionOf(enrollmentId)),
      policy: { ...DEMO_ASSESSMENT_POLICY },
      checks: [
        {
          checkId: "gate:notice",
          title: "Notice a pattern",
          used: 1,
          limit: limit("gate:notice"),
          granted: grants.get("gate:notice") ?? 0,
          retryAt: null,
        },
        {
          checkId: "gate:apply",
          title: "Apply the idea",
          used: 3,
          limit: limit("gate:apply"),
          granted: grants.get("gate:apply") ?? 0,
          retryAt: null,
        },
      ],
    };
  }
  return {
    async getAssessmentAttempts(enrollmentId, signal) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return view(enrollmentId);
    },
    async grantAssessmentAttempt(enrollmentId, input, context) {
      permitGrant(enrollmentId);
      const replay = receipts.get(`${enrollmentId}:${context.idempotencyKey}`);
      if (replay) return structuredClone(replay);
      if (!input.reason.trim() || input.reason.length > 1000)
        throw new AdminError("validation");
      if (!["gate:notice", "gate:apply"].includes(input.checkId))
        throw new AdminError("not_found");
      if (context.expectedRevision !== (await revisionOf(enrollmentId)))
        throw new AdminError("stale_revision");
      const grants = granted.get(enrollmentId) ?? new Map<string, number>();
      grants.set(input.checkId, (grants.get(input.checkId) ?? 0) + 1);
      granted.set(enrollmentId, grants);
      const result = {
        ...(await view(enrollmentId, context.expectedRevision)),
        receipt: {
          id: `demo-attempt-grant-${++sequence}`,
          authority: "demo" as const,
          outcome: "granted",
        },
      };
      receipts.set(
        `${enrollmentId}:${context.idempotencyKey}`,
        structuredClone(result),
      );
      return result;
    },
  };
}
