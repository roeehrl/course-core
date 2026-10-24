import { useEffect, useId, useState, type FormEvent } from "react";
import type { AdminClient } from "../domain/contracts";
import {
  losesCredit,
  moveCodeMessage,
  moveErrorMessage,
  type LearnerImpact,
  type MoveDetail,
  type MovePreview,
  type VersionMovesView,
} from "../domain/versionMoves";
import { useFormatters, useI18n, type MessageKey } from "../i18n";
import { Badge, Button, Card, Field, Notice } from "./ui";

type Lessons = LearnerImpact["progress"]["checkpointsAgain"];
type Checkpoints = LearnerImpact["carryOver"]["carried"];
const outcomeTone = { ready: "green", waits: "gold", refused: "red" } as const;
const stateTone = {
  moved: "green",
  waiting: "gold",
  refused: "red",
  undone: "neutral",
  cancelled: "neutral",
} as const;

/** Course & releases → Move learners to a newer version (Core K13): pick who and where, see
 * exactly what happens to each learner, confirm with a reason, and undo where it is safe. */
export function VersionMoves({
  client,
  courseId,
  onMoved,
}: {
  client: AdminClient;
  courseId: string;
  /** Called after learners moved (or moved back), so the enrollment list can refresh. */
  onMoved?: () => void;
}) {
  const port = client.versionMoves!;
  const i18n = useI18n();
  const t = i18n.t;
  const { when } = useFormatters();
  const id = useId();
  const [view, setView] = useState<VersionMovesView>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [who, setWho] = useState<"cohort" | "learner">("cohort");
  const [learners, setLearners] =
    useState<{ enrollmentId: string; displayName: string | null }[]>();
  const [learnerId, setLearnerId] = useState("");
  const [preview, setPreview] = useState<MovePreview>();
  const [reason, setReason] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [open, setOpen] = useState<MoveDetail>();
  const [undoReason, setUndoReason] = useState("");
  const [forceReason, setForceReason] = useState("");

  const movable = (next: VersionMovesView) =>
    next.versions.filter((v) => v.learners > 0 && v.newer.length > 0);
  function adopt(next: VersionMovesView) {
    setView(next);
    const choices = movable(next);
    const from =
      choices.find((v) => v.releaseId === fromId) ?? choices[0] ?? undefined;
    setFromId(from?.releaseId ?? "");
    setToId(
      from?.newer.some((v) => v.releaseId === toId)
        ? toId
        : (from?.newer[0]?.releaseId ?? ""),
    );
  }
  async function load(signal?: AbortSignal) {
    adopt(await port.get(courseId, signal));
  }
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch((cause) => {
      if (!controller.signal.aborted) setError(moveErrorMessage(cause, t));
    });
    return () => controller.abort();
  }, [port, courseId]);
  useEffect(() => {
    if (who !== "learner" || !fromId) return;
    const controller = new AbortController();
    setLearners(undefined);
    port.learners(courseId, fromId, controller.signal).then(
      (result) => {
        setLearners(result.learners);
        setLearnerId(result.learners[0]?.enrollmentId ?? "");
      },
      (cause) => {
        if (!controller.signal.aborted) setError(moveErrorMessage(cause, t));
      },
    );
    return () => controller.abort();
  }, [port, courseId, who, fromId]);

  async function run(action: () => Promise<void>) {
    setPending(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (cause) {
      setError(moveErrorMessage(cause, t));
    } finally {
      setPending(false);
    }
  }
  const showPreview = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      setPreview(undefined);
      setAcknowledged(false);
      setPreview(
        await port.preview(courseId, {
          fromReleaseId: fromId,
          toReleaseId: toId,
          ...(who === "learner" ? { enrollmentId: learnerId } : {}),
        }),
      );
    });
  };
  const confirm = (event: FormEvent) => {
    event.preventDefault();
    if (!preview) return;
    void run(async () => {
      const done = await port.confirm(courseId, preview.moveId, {
        previewDigest: preview.previewDigest,
        reason: reason.trim(),
        acknowledgeLostCredit: acknowledged,
      });
      setPreview(undefined);
      setReason("");
      setOpen(done);
      setNotice(t("versionMoves.result.done", done.totals));
      await load();
      onMoved?.();
    });
  };
  const showDetail = (moveId: string) =>
    void run(async () => {
      setOpen(
        open?.moveId === moveId
          ? undefined
          : await port.detail(courseId, moveId),
      );
      setUndoReason("");
    });
  const undo = (moveId: string, enrollmentIds?: string[]) =>
    void run(async () => {
      const result = await port.undo(courseId, moveId, {
        reason: undoReason.trim(),
        ...(enrollmentIds ? { enrollmentIds } : {}),
      });
      setOpen(result.move);
      setNotice(
        [
          t("versionMoves.history.undone", { count: result.undone.length }),
          result.refused.length
            ? t("versionMoves.history.undoRefused", {
                count: result.refused.length,
              })
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
      await load();
      onMoved?.();
    });
  const force = (moveId: string, enrollmentId: string) =>
    void run(async () => {
      const result = await port.force(courseId, moveId, enrollmentId, {
        reason: forceReason.trim(),
      });
      setOpen(result.move);
      setForceReason("");
      setNotice(
        result.status === "withdrawn"
          ? t("versionMoves.force.withdrawn", {
              reason: moveCodeMessage(result.code, t),
            })
          : t(`versionMoves.force.${result.status}` as MessageKey),
      );
      await load();
      onMoved?.();
    });
  const cancel = (moveId: string) =>
    void run(async () => {
      const result = await port.cancel(courseId, moveId);
      setOpen(result.move);
      setNotice(
        t("versionMoves.history.cancelled", { count: result.cancelled }),
      );
      await load();
    });

  const card = (children: React.ReactNode) => (
    <Card title={t("versionMoves.title")} eyebrow={t("versionMoves.eyebrow")}>
      {notice && <Notice tone="green">{notice}</Notice>}
      {error && (
        <Notice tone="red" title={t("versionMoves.notCompleted")}>
          {error}
        </Notice>
      )}
      {children}
    </Card>
  );
  if (!view) return card(!error && <p>{t("versionMoves.loading")}</p>);

  const lessonList = (lessons: Lessons) => {
    const titles = i18n.list(lessons.items.map((l) => l.title));
    return lessons.count > lessons.items.length
      ? t("versionMoves.learner.more", {
          lessons: titles,
          count: lessons.count - lessons.items.length,
        })
      : titles;
  };
  const name = (displayName: string | null) =>
    displayName || t("versionMoves.learner.unnamed");
  const choices = movable(view);
  const from = view.versions.find((v) => v.releaseId === fromId);
  const lostCredit = preview?.learners.filter(losesCredit).length ?? 0;
  const movableCount =
    preview?.learners.filter((l) => l.outcome !== "refused").length ?? 0;
  const offeredCount =
    preview?.learners.filter((l) => l.refusal === "MOVE_PERSONAL_CHANGES")
      .length ?? 0;
  const checkpointList = (items: Checkpoints) =>
    lessonList({ count: items.count, items: items.items });

  return card(
    <>
      <p>{t("versionMoves.intro")}</p>
      <h3>{t("versionMoves.versions.title")}</h3>
      <ul className="plain-list">
        {view.versions.map((version) => (
          <li key={version.releaseId}>
            {t("versionMoves.versions.row", {
              version: version.version,
              learners: version.learners,
            })}
            {" · "}
            <small>
              {version.newer.length
                ? t("versionMoves.versions.newer", {
                    versions: i18n.list(version.newer.map((n) => n.version)),
                  })
                : version.status === "published"
                  ? t("versionMoves.versions.latest")
                  : null}
            </small>
          </li>
        ))}
      </ul>
      {!view.permissions.move ? (
        <Notice tone="blue">{t("versionMoves.noPermission")}</Notice>
      ) : !choices.length ? (
        <Notice tone="blue">{t("versionMoves.nothingToMove")}</Notice>
      ) : (
        <form className="form-grid" onSubmit={showPreview}>
          <Field label={t("versionMoves.form.from")} htmlFor={`${id}-from`}>
            <select
              id={`${id}-from`}
              value={fromId}
              onChange={(event) => {
                const next = choices.find(
                  (v) => v.releaseId === event.target.value,
                );
                setFromId(event.target.value);
                setToId(next?.newer[0]?.releaseId ?? "");
                setPreview(undefined);
              }}
            >
              {choices.map((v) => (
                <option key={v.releaseId} value={v.releaseId}>
                  {t("versionMoves.versions.row", {
                    version: v.version,
                    learners: v.learners,
                  })}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("versionMoves.form.to")} htmlFor={`${id}-to`}>
            <select
              id={`${id}-to`}
              value={toId}
              onChange={(event) => {
                setToId(event.target.value);
                setPreview(undefined);
              }}
            >
              {from?.newer.map((v) => (
                <option key={v.releaseId} value={v.releaseId}>
                  {v.version}
                </option>
              ))}
            </select>
          </Field>
          <fieldset>
            <legend>{t("versionMoves.form.who")}</legend>
            <label>
              <input
                type="radio"
                name={`${id}-who`}
                checked={who === "cohort"}
                onChange={() => {
                  setWho("cohort");
                  setPreview(undefined);
                }}
              />{" "}
              {t("versionMoves.form.who.cohort", {
                version: from?.version ?? "",
                count: from?.learners ?? 0,
              })}
            </label>
            <label>
              <input
                type="radio"
                name={`${id}-who`}
                checked={who === "learner"}
                onChange={() => {
                  setWho("learner");
                  setPreview(undefined);
                }}
              />{" "}
              {t("versionMoves.form.who.learner")}
            </label>
          </fieldset>
          {who === "learner" && (
            <Field
              label={t("versionMoves.form.learner")}
              htmlFor={`${id}-learner`}
            >
              {learners ? (
                <select
                  id={`${id}-learner`}
                  value={learnerId}
                  onChange={(event) => {
                    setLearnerId(event.target.value);
                    setPreview(undefined);
                  }}
                >
                  {learners.map((l) => (
                    <option key={l.enrollmentId} value={l.enrollmentId}>
                      {l.displayName || t("versionMoves.form.learner.unnamed")}
                    </option>
                  ))}
                </select>
              ) : (
                <p id={`${id}-learner`}>
                  {t("versionMoves.form.learner.loading")}
                </p>
              )}
            </Field>
          )}
          <div>
            <Button
              kind="primary"
              type="submit"
              disabled={
                pending || !fromId || !toId || (who === "learner" && !learnerId)
              }
            >
              {t("versionMoves.form.preview")}
            </Button>
            <small> {t("versionMoves.form.previewHint")}</small>
          </div>
        </form>
      )}

      {preview && (
        <section
          aria-labelledby={`${id}-preview`}
          className="version-move-preview"
        >
          <h3 id={`${id}-preview`}>
            {t("versionMoves.preview.title", { to: preview.to.version })}
          </h3>
          <p>
            {t("versionMoves.preview.content", {
              from: preview.from.version,
              to: preview.to.version,
              added: preview.content.lessons.added,
              changed: preview.content.lessons.changed,
              removed: preview.content.lessons.removed,
            })}
          </p>
          {preview.content.newLessons.length > 0 && (
            <p>
              {t("versionMoves.preview.newLessons", {
                lessons: i18n.list(
                  preview.content.newLessons.map((l) => l.title),
                ),
              })}
            </p>
          )}
          <dl className="facts">
            {(
              [
                "ready",
                "waits",
                "refused",
                "losingCredit",
                "carriedCheckpoints",
                "offered",
              ] as const
            ).map((key) => (
              <div key={key}>
                <dt>{t(`versionMoves.preview.totals.${key}` as MessageKey)}</dt>
                <dd>{preview.totals[key]}</dd>
              </div>
            ))}
          </dl>
          <p>
            <small>
              {t("versionMoves.preview.rules", {
                days: preview.rules.waitsAtMostDays,
              })}
            </small>
          </p>
          <ul className="plain-list">
            {preview.learners.map((learner) => (
              <li key={learner.enrollmentId}>
                <div className="split-line">
                  <strong>{name(learner.displayName)}</strong>
                  <Badge tone={outcomeTone[learner.outcome]}>
                    {t(
                      `versionMoves.learner.outcome.${learner.outcome}` as MessageKey,
                    )}
                  </Badge>
                </div>
                {learner.refusal === "MOVE_PERSONAL_CHANGES" && (
                  <PersonalChangeLines
                    lines={learner.personalChangeList}
                    lessonList={lessonList}
                  />
                )}
                {learner.carryOver.carried.count > 0 && (
                  <p>
                    {t("versionMoves.carry.carried", {
                      lessons: checkpointList(learner.carryOver.carried),
                    })}
                  </p>
                )}
                {learner.carryOver.notCarried.items.map((item) => (
                  <p key={item.gateId}>
                    {t("versionMoves.carry.notCarried", {
                      lesson: item.title,
                      reason: moveCodeMessage(item.code, t),
                    })}
                  </p>
                ))}
                {learner.refusal ? (
                  <p>{moveCodeMessage(learner.refusal, t)}</p>
                ) : (
                  <>
                    {learner.wait && <p>{moveCodeMessage(learner.wait, t)}</p>}
                    <p>
                      {t("versionMoves.learner.kept", {
                        count: learner.progress.kept,
                      })}
                    </p>
                    {learner.progress.checkpointsAgain.count > 0 && (
                      <p>
                        {t("versionMoves.learner.checkpointsAgain", {
                          lessons: lessonList(
                            learner.progress.checkpointsAgain,
                          ),
                        })}
                      </p>
                    )}
                    {learner.progress.onHold.count > 0 && (
                      <p>
                        {t("versionMoves.learner.onHold", {
                          lessons: lessonList(learner.progress.onHold),
                        })}
                      </p>
                    )}
                    {learner.progress.removed.count > 0 && (
                      <p>
                        {t("versionMoves.learner.removed", {
                          lessons: lessonList(learner.progress.removed),
                        })}
                      </p>
                    )}
                    {learner.progress.changedKept.count > 0 && (
                      <p>
                        {t("versionMoves.learner.changedKept", {
                          lessons: lessonList(learner.progress.changedKept),
                        })}
                      </p>
                    )}
                    {learner.progress.completeBefore &&
                      !learner.progress.completeAfter && (
                        <p>{t("versionMoves.learner.complete")}</p>
                      )}
                    <p>
                      {t("versionMoves.learner.evidence", {
                        count: learner.evidence.records,
                        from: preview.from.version,
                      })}
                    </p>
                    {learner.openWork.questions + learner.openWork.activities >
                      0 && (
                      <p>
                        {t("versionMoves.learner.openWork", learner.openWork)}
                      </p>
                    )}
                    <p>
                      {t("versionMoves.learner.policy", {
                        count: learner.policy.addedScopes.length,
                      })}
                    </p>
                    {learner.progress.nextAfter && (
                      <p>
                        {t("versionMoves.learner.next", {
                          lesson: learner.progress.nextAfter.title,
                        })}
                      </p>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
          <p>
            <small>
              {t("versionMoves.preview.expires", {
                when: when(preview.expiresAt),
              })}
            </small>
          </p>
          {offeredCount > 0 && (
            <Notice tone="blue">
              {t("versionMoves.confirm.offered", { count: offeredCount })}
            </Notice>
          )}
          {movableCount + offeredCount === 0 ? (
            <Notice tone="gold">{t("versionMoves.confirm.nobody")}</Notice>
          ) : (
            <form onSubmit={confirm} className="form-grid">
              <h3>{t("versionMoves.confirm.title")}</h3>
              <Field
                label={t("versionMoves.confirm.reason")}
                hint={t("versionMoves.confirm.reasonHint")}
                htmlFor={`${id}-reason`}
              >
                <textarea
                  id={`${id}-reason`}
                  aria-describedby={`${id}-reason-hint`}
                  value={reason}
                  maxLength={1000}
                  required
                  onChange={(event) => setReason(event.target.value)}
                />
              </Field>
              {lostCredit > 0 && (
                <label>
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(event) => setAcknowledged(event.target.checked)}
                  />{" "}
                  {t("versionMoves.confirm.acknowledge", { count: lostCredit })}
                </label>
              )}
              <div className="button-row">
                <Button
                  kind="primary"
                  type="submit"
                  disabled={
                    pending ||
                    !reason.trim() ||
                    (lostCredit > 0 && !acknowledged)
                  }
                >
                  {movableCount > 0
                    ? t("versionMoves.confirm.submit", { count: movableCount })
                    : t("versionMoves.confirm.offerOnly", {
                        count: offeredCount,
                      })}
                </Button>
                <Button type="button" onClick={() => setPreview(undefined)}>
                  {t("versionMoves.confirm.discard")}
                </Button>
              </div>
            </form>
          )}
        </section>
      )}

      <h3>{t("versionMoves.history.title")}</h3>
      {view.moves.length === 0 ? (
        <p>{t("versionMoves.history.empty")}</p>
      ) : (
        <ul className="plain-list">
          {view.moves.map((move) => (
            <li key={move.moveId}>
              <div className="split-line">
                <strong>
                  {t("versionMoves.history.row", {
                    from: move.from.version,
                    to: move.to.version,
                    when: when(move.confirmedAt ?? move.createdAt),
                  })}
                </strong>
                <small>
                  {t(`versionMoves.history.scope.${move.scope}` as MessageKey)}
                </small>
              </div>
              <small>{t("versionMoves.history.totals", move.totals)}</small>
              {move.reason && (
                <p>
                  <small>
                    {t("versionMoves.history.reason", { reason: move.reason })}
                  </small>
                </p>
              )}
              <div className="button-row">
                <Button
                  type="button"
                  disabled={pending}
                  onClick={() => showDetail(move.moveId)}
                >
                  {open?.moveId === move.moveId
                    ? t("versionMoves.history.hide")
                    : t("versionMoves.history.details")}
                </Button>
                {view.permissions.move && move.totals.waiting > 0 && (
                  <Button
                    type="button"
                    disabled={pending}
                    onClick={() => cancel(move.moveId)}
                  >
                    {t("versionMoves.history.cancel")}
                  </Button>
                )}
              </div>
              {open?.moveId === move.moveId && (
                <MoveLearners
                  detail={open}
                  canUndo={view.permissions.move}
                  pending={pending}
                  reason={undoReason}
                  onReason={setUndoReason}
                  onUndo={(ids) => undo(move.moveId, ids)}
                  forceReason={forceReason}
                  onForceReason={setForceReason}
                  onForce={(enrollmentId) => force(move.moveId, enrollmentId)}
                  name={name}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </>,
  );
}

/** The personal changes a move would drop for one learner (lesson and kind). */
function PersonalChangeLines({
  lines,
  lessonList,
}: {
  lines: LearnerImpact["personalChangeList"];
  lessonList: (lessons: Lessons) => string;
}) {
  const { t } = useI18n();
  return (
    <p>
      {lines.items.length
        ? t("versionMoves.personal.list", {
            lessons: lessonList({
              count: lines.count,
              items: lines.items.map((line) => ({
                id: line.episodeId,
                title: line.title,
              })),
            }),
          })
        : t("versionMoves.personal.unlisted")}
    </p>
  );
}

function MoveLearners({
  detail,
  canUndo,
  pending,
  reason,
  onReason,
  onUndo,
  forceReason,
  onForceReason,
  onForce,
  name,
}: {
  detail: MoveDetail;
  canUndo: boolean;
  pending: boolean;
  reason: string;
  onReason: (value: string) => void;
  onUndo: (enrollmentIds?: string[]) => void;
  forceReason: string;
  onForceReason: (value: string) => void;
  onForce: (enrollmentId: string) => void;
  name: (displayName: string | null) => string;
}) {
  const { t } = useI18n();
  const id = useId();
  const undoable = detail.learners.filter((l) => l.undo?.possible);
  return (
    <div className="version-move-learners">
      <ul className="plain-list">
        {detail.learners.map((learner) => (
          <li key={learner.enrollmentId}>
            <div className="split-line">
              <span>{name(learner.displayName)}</span>
              <Badge tone={stateTone[learner.state]}>
                {t(`versionMoves.state.${learner.state}` as MessageKey)}
              </Badge>
            </div>
            {learner.code && <small>{moveCodeMessage(learner.code, t)}</small>}
            {learner.offer && (
              <p>
                <small>
                  {t(
                    `versionMoves.offer.${learner.offer.state}` as MessageKey,
                    {
                      reason: learner.offer.reason ?? "",
                      code: moveCodeMessage(learner.offer.code, t),
                    },
                  )}
                </small>
              </p>
            )}
            {canUndo && learner.offer?.forcible && (
              <div className="form-grid">
                <Field
                  label={t("versionMoves.force.reason")}
                  hint={t("versionMoves.force.hint")}
                  htmlFor={`${id}-force-${learner.enrollmentId}`}
                >
                  <input
                    id={`${id}-force-${learner.enrollmentId}`}
                    value={forceReason}
                    maxLength={1000}
                    onChange={(event) => onForceReason(event.target.value)}
                  />
                </Field>
                <Button
                  type="button"
                  kind="danger"
                  disabled={pending || !forceReason.trim()}
                  onClick={() => onForce(learner.enrollmentId)}
                >
                  {t("versionMoves.force.submit")}
                </Button>
              </div>
            )}
            {learner.undo && !learner.undo.possible && (
              <small>
                {t("versionMoves.history.undoNotPossible", {
                  reason: moveCodeMessage(learner.undo.code, t),
                })}
              </small>
            )}
            {canUndo && learner.undo?.possible && (
              <Button
                type="button"
                kind="quiet"
                disabled={pending || !reason.trim()}
                onClick={() => onUndo([learner.enrollmentId])}
              >
                {t("versionMoves.history.undoOne")}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {canUndo && undoable.length > 0 && (
        <div className="form-grid">
          <Field
            label={t("versionMoves.history.undoReason")}
            htmlFor={`${id}-undo`}
          >
            <input
              id={`${id}-undo`}
              value={reason}
              maxLength={1000}
              onChange={(event) => onReason(event.target.value)}
            />
          </Field>
          <Button
            type="button"
            kind="danger"
            disabled={pending || !reason.trim()}
            onClick={() => onUndo()}
          >
            {t("versionMoves.history.undoAll", { count: undoable.length })}
          </Button>
        </div>
      )}
    </div>
  );
}
