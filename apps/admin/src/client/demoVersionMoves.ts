import type { CourseWorkspace } from "../domain/contracts";
import type { Translate } from "../i18n";
import { compareVersions } from "../domain/versions";
import {
  VersionMoveError,
  type LearnerImpact,
  type MoveDetail,
  type MovePreview,
  type VersionMovesPort,
} from "../domain/versionMoves";

/**
 * In-memory version moves for the public demo (fictional data, nothing leaves the browser).
 * It follows the server's rules where the demo can: only forward, only to a published version,
 * only active or paused learners, a preview confirmed by its digest with a reason, and undo only
 * while the learner has not changed since. Demo learners have no open questions, so nobody waits.
 */
export function createDemoVersionMoves({
  getWorkspace,
  setWorkspace,
  scenario,
  latency,
  translate,
}: {
  getWorkspace: (courseId: string) => CourseWorkspace;
  setWorkspace: (courseId: string, workspace: CourseWorkspace) => void;
  scenario: string;
  latency: number;
  /** The translator for the demo course's fictional lesson title. */
  translate: () => Translate;
}): VersionMovesPort {
  type Stored = MoveDetail & { courseId: string; preview: MovePreview };
  const moves = new Map<string, Stored>();
  let sequence = 0;
  const clone = <T>(value: T): T => structuredClone(value);
  async function delay(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (latency) await new Promise((resolve) => setTimeout(resolve, latency));
  }
  function workspace(courseId: string, write = false) {
    if (scenario === "load_failure") throw new VersionMoveError("UNAVAILABLE");
    let current: CourseWorkspace;
    try {
      current = getWorkspace(courseId);
    } catch {
      throw new VersionMoveError("COURSE_NOT_FOUND");
    }
    const allowed =
      current.permissions.includes("enrollment.write") &&
      current.permissions.includes("policy.write");
    if (write && (scenario === "permission_denied" || !allowed))
      throw new VersionMoveError("FORBIDDEN");
    return current;
  }
  const published = (current: CourseWorkspace) =>
    current.releases.filter((r) => r.state === "published");
  const releaseOf = (current: CourseWorkspace, id: string) => {
    const release = current.releases.find((r) => r.id === id);
    if (!release) throw new VersionMoveError("RELEASE_NOT_FOUND");
    return release;
  };
  const onVersion = (current: CourseWorkspace, version: string) =>
    current.enrollments.filter(
      (e) =>
        e.releaseVersion === version &&
        (e.status === "active" || e.status === "paused"),
    );
  const summary = (move: Stored) => ({
    ...clone(move),
    courseId: undefined,
    preview: undefined,
    learners: undefined,
    undoable: move.learners.filter((l) => l.undo?.possible).length,
  });
  const detail = (move: Stored): MoveDetail => {
    const { courseId: _c, preview: _p, ...rest } = clone(move);
    return rest;
  };
  const totals = (move: Stored) => ({
    moved: move.learners.filter((l) => l.state === "moved").length,
    waiting: 0,
    refused: move.learners.filter((l) => l.state === "refused").length,
    undone: move.learners.filter((l) => l.state === "undone").length,
    cancelled: 0,
  });
  return {
    async get(courseId, signal) {
      await delay(signal);
      const current = workspace(courseId);
      const versions = current.releases
        .filter((r) => r.state === "published" || r.state === "archived")
        .map((release) => ({
          releaseId: release.id,
          version: release.version,
          status: release.state,
          learners: onVersion(current, release.version).length,
          newer: published(current)
            .filter(
              (other) =>
                (compareVersions(other.version, release.version) ?? 0) > 0,
            )
            .map((other) => ({ releaseId: other.id, version: other.version })),
        }));
      return {
        versions,
        moves: [...moves.values()]
          .filter((m) => m.courseId === courseId)
          .reverse()
          .map((m) => summary(m) as never),
        permissions: {
          move:
            current.permissions.includes("enrollment.write") &&
            current.permissions.includes("policy.write"),
        },
      };
    },
    async learners(courseId, releaseId, signal) {
      await delay(signal);
      const current = workspace(courseId);
      return {
        learners: onVersion(current, releaseOf(current, releaseId).version).map(
          (e) => ({
            enrollmentId: e.id,
            displayName: e.profile.displayName,
            status: e.status,
          }),
        ),
      };
    },
    async preview(courseId, input) {
      await delay();
      const current = workspace(courseId, true);
      const from = releaseOf(current, input.fromReleaseId);
      const to = releaseOf(current, input.toReleaseId);
      if (from.id === to.id) throw new VersionMoveError("MOVE_SAME_VERSION");
      if (to.state !== "published")
        throw new VersionMoveError("MOVE_TARGET_NOT_PUBLISHED");
      if ((compareVersions(to.version, from.version) ?? 0) <= 0)
        throw new VersionMoveError("MOVE_TARGET_NOT_NEWER");
      const cohort = input.enrollmentId
        ? current.enrollments.filter(
            (e) =>
              e.id === input.enrollmentId && e.releaseVersion === from.version,
          )
        : onVersion(current, from.version);
      if (input.enrollmentId && !cohort.length)
        throw new VersionMoveError("ENROLLMENT_NOT_FOUND");
      const newLesson = {
        id: "optional-practice",
        title: translate()("demoClient.versionMoves.newLesson"),
      };
      const none = { count: 0, items: [] };
      const learners: LearnerImpact[] = cohort.map((e) => {
        const movable = e.status === "active" || e.status === "paused";
        return {
          enrollmentId: e.id,
          displayName: e.profile.displayName,
          status: e.status,
          outcome: movable ? "ready" : "refused",
          refusal: movable ? null : "MOVE_ENROLLMENT_NOT_ACTIVE",
          policyCode: null,
          wait: null,
          progress: {
            completeBefore: false,
            completeAfter: false,
            creditedBefore: e.completed,
            creditedAfter: e.completed,
            kept: e.completed,
            changedKept: none,
            checkpointsAgain: none,
            onHold: none,
            removed: none,
            nextBefore: null,
            nextAfter: null,
          },
          evidence: {
            records: e.evidence.filter((item) => item.status === "accepted")
              .length,
          },
          openWork: { questions: 0, activities: 0 },
          personalChanges: 0,
          policy: {
            addedScopes: movable ? [`episode:${newLesson.id}`] : [],
            keptScopes: movable ? 4 : 0,
          },
          costDigest: "0".repeat(64),
        };
      });
      const moveId = `demo-move-${++sequence}`;
      const preview: MovePreview = {
        moveId,
        previewDigest: (sequence.toString(16) + "a".repeat(64)).slice(0, 64),
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        scope: input.enrollmentId ? "learner" : "cohort",
        enrollmentId: input.enrollmentId ?? null,
        from: { releaseId: from.id, version: from.version },
        to: { releaseId: to.id, version: to.version },
        content: {
          changes: 2,
          lessons: { added: 1, removed: 0, changed: 1, unchanged: 2 },
          questions: { added: 0, removed: 0, changed: 0 },
          newLessons: [newLesson],
        },
        totals: {
          learners: learners.length,
          ready: learners.filter((l) => l.outcome === "ready").length,
          waits: 0,
          refused: learners.filter((l) => l.outcome === "refused").length,
          losingCredit: 0,
        },
        learners,
        rules: { waitsAtMostDays: 7 },
      };
      moves.set(moveId, {
        courseId,
        preview,
        moveId,
        scope: preview.scope,
        state: "previewed",
        reason: null,
        from: preview.from,
        to: preview.to,
        createdAt: new Date().toISOString(),
        confirmedAt: null,
        totals: { moved: 0, waiting: 0, refused: 0, undone: 0, cancelled: 0 },
        learners: [],
      });
      return clone(preview);
    },
    async confirm(courseId, moveId, input) {
      await delay();
      const current = clone(workspace(courseId, true));
      const move = moves.get(moveId);
      if (!move || move.courseId !== courseId)
        throw new VersionMoveError("STALE_PREVIEW");
      if (move.state === "confirmed") return detail(move);
      if (input.previewDigest !== move.preview.previewDigest)
        throw new VersionMoveError("STALE_PREVIEW");
      if (!input.reason.trim()) throw new VersionMoveError("INVALID_REQUEST");
      if (!move.preview.learners.some((l) => l.outcome === "ready"))
        throw new VersionMoveError("MOVE_NOBODY_TO_MOVE");
      const at = new Date().toISOString();
      move.learners = move.preview.learners.map((impact) => {
        const enrollment = current.enrollments.find(
          (e) => e.id === impact.enrollmentId,
        );
        const ready =
          impact.outcome === "ready" &&
          enrollment?.releaseVersion === move.from.version;
        if (ready) enrollment.releaseVersion = move.to.version;
        return {
          enrollmentId: impact.enrollmentId,
          displayName: impact.displayName,
          state: ready ? ("moved" as const) : ("refused" as const),
          code: ready ? null : (impact.refusal ?? "MOVE_ENROLLMENT_CHANGED"),
          movedAt: ready ? at : null,
          undoneAt: null,
          undo: ready ? { possible: true, code: null } : null,
        };
      });
      move.state = "confirmed";
      move.reason = input.reason.trim();
      move.confirmedAt = at;
      move.totals = totals(move);
      current.revision = String(Number(current.revision) + 1);
      setWorkspace(courseId, current);
      return detail(move);
    },
    async detail(courseId, moveId, signal) {
      await delay(signal);
      workspace(courseId);
      const move = moves.get(moveId);
      if (!move || move.courseId !== courseId || move.state !== "confirmed")
        throw new VersionMoveError("MOVE_NOT_FOUND");
      return detail(move);
    },
    async undo(courseId, moveId, input) {
      await delay();
      const current = clone(workspace(courseId, true));
      const move = moves.get(moveId);
      if (!move || move.courseId !== courseId || move.state !== "confirmed")
        throw new VersionMoveError("MOVE_NOT_FOUND");
      if (!input.reason.trim()) throw new VersionMoveError("INVALID_REQUEST");
      const undone: string[] = [];
      const refused: { enrollmentId: string; code: string }[] = [];
      for (const learner of move.learners) {
        if (learner.state !== "moved") continue;
        if (
          input.enrollmentIds &&
          !input.enrollmentIds.includes(learner.enrollmentId)
        )
          continue;
        const enrollment = current.enrollments.find(
          (e) => e.id === learner.enrollmentId,
        );
        if (enrollment?.releaseVersion !== move.to.version) {
          refused.push({
            enrollmentId: learner.enrollmentId,
            code: "UNDO_LEARNER_CONTINUED",
          });
          continue;
        }
        enrollment.releaseVersion = move.from.version;
        learner.state = "undone";
        learner.undoneAt = new Date().toISOString();
        learner.undo = null;
        undone.push(learner.enrollmentId);
      }
      if (!undone.length && !refused.length)
        throw new VersionMoveError("UNDO_NOTHING_TO_UNDO");
      move.totals = totals(move);
      current.revision = String(Number(current.revision) + 1);
      setWorkspace(courseId, current);
      return { undone, refused, move: detail(move) };
    },
    async cancel(courseId) {
      await delay();
      workspace(courseId, true);
      // Demo learners never wait, so there is never anything to stop.
      throw new VersionMoveError("MOVE_NOTHING_WAITING");
    },
  };
}
