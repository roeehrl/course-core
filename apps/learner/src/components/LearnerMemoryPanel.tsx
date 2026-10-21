import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { CourseApiError, type ServerSnapshot } from "../client/apiClient";
import type {
  EvidenceControlAction,
  LearnerMemoryClient,
  MemoryChanges,
  MemoryDecision,
  MemoryHistory,
  MemoryHistoryKind,
  MemoryProfile,
  MemoryProposal,
  MemoryReceipt,
  MemoryScope,
  MemorySnapshot,
  MemorySuggestion,
  MemoryUnderstanding,
} from "../client/memoryClient";
import { isolateLtr } from "@course-core/i18n";
import {
  englishTranslator,
  useI18n,
  useT,
  type LearnerTranslator,
  type MessageKey,
  type Translate,
} from "../i18n";
import { Badge, Button, ChoiceList, colors, Field, Notice, styles } from "./ui";
import { useReservedHeight } from "./reservedHeight";
import { DeclaredProfileFields } from "./DeclaredProfileFields";

/** Ids and digests stay left to right inside right-to-left text. */
function useLtr() {
  const { dir } = useI18n();
  return dir === "rtl" ? isolateLtr : (value: string) => value;
}

export interface LearnerMemoryPanelProps {
  account: { id: string; displayName: string } | null;
  enrollment:
    | (Pick<
        ServerSnapshot,
        "enrollmentId" | "revision" | "courseDigest" | "course"
      > & { workspaceId?: string })
    | null;
  api: LearnerMemoryClient;
  episodeId?: string;
  /** Refresh the host's enrollment snapshot after a confirmed mutation. */
  onRevision?: (revision: number) => void;
}
/** Host contract: memoize createMemoryClient(existingCourseApi, account.id) for
 * the authenticated account, not for each opening of this panel. Place inside
 * the host's ScrollView (keyboardShouldPersistTaps="handled") / profile flow.
 * This is an inline portable panel; the host owns drawer focus and dismissal.
 * Changing account/enrollment/course/episode clears local private state at once.
 * Drafts are memory-only. Unconfirmed writes remain in the account's client for
 * exact retry; refresh never silently resubmits or overwrites another revision.
 * The API retains prior edits. Removing a self-report is not audit erasure.
 */
export function LearnerMemoryPanel(props: LearnerMemoryPanelProps) {
  const { account, enrollment, api } = props;
  const t = useT();
  if (!account) return <Notice>{t("learnerMemoryPanel.notice.signIn")}</Notice>;
  if (!enrollment)
    return <Notice>{t("learnerMemoryPanel.notice.chooseEnrollment")}</Notice>;
  if (api.accountId !== account.id)
    return (
      <Notice error>{t("learnerMemoryPanel.notice.accountChanging")}</Notice>
    );
  const episodeId =
    props.episodeId ?? enrollment.course.chapters[0]?.episodes[0]?.id;
  if (
    !episodeId ||
    !enrollment.course.chapters.some((chapter) =>
      chapter.episodes.some((episode) => episode.id === episodeId),
    )
  ) {
    return <Notice>{t("learnerMemoryPanel.notice.lessonUnavailable")}</Notice>;
  }
  return (
    <MemoryPanel
      key={JSON.stringify([
        account.id,
        enrollment.enrollmentId,
        enrollment.courseDigest,
        enrollment.workspaceId,
        episodeId,
      ])}
      {...props}
      account={account}
      enrollment={enrollment}
      episodeId={episodeId}
    />
  );
}

const paceIds = ["gentle", "steady", "focused"] as const;
const styleIds = ["concise", "step_by_step", "worked_example"] as const;
const paceOptions = (t: Translate) =>
  paceIds.map((id) => ({
    id,
    label: t(`learnerMemoryPanel.pace.${id}` as MessageKey),
  }));
const styleOptions = (t: Translate) =>
  styleIds.map((id) => ({
    id,
    label: t(`learnerMemoryPanel.style.${id}` as MessageKey),
  }));
const cleanProfile = (value: MemoryProfile): MemoryProfile => ({
  preferences: { ...value.preferences },
  priorKnowledge: value.priorKnowledge.map((row) => ({ ...row })),
  thoughts: value.thoughts,
});
/** API error codes this panel explains; anything else gets the generic message. */
const ERROR_CODES = new Set([
  "STALE_REVISION",
  "PROPOSAL_SOURCE_CHANGED",
  "PROPOSAL_NOT_FOUND",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NETWORK_UNCERTAIN",
  "PENDING_UNCERTAIN",
  "INVALID_REQUEST",
  "INVALID_RESPONSE",
  "EVIDENCE_NOT_FOUND",
  "EVIDENCE_CONTROL_UNCHANGED",
  "EVIDENCE_INVALIDATED",
  "EVIDENCE_DISPUTE_LIMIT",
  "CSRF_REJECTED",
  "ORIGIN_REJECTED",
]);
function errorCopy(error: unknown, t: Translate = englishTranslator().t) {
  if (!(error instanceof CourseApiError))
    return t("learnerMemoryPanel.error.notUpdated");
  return ERROR_CODES.has(error.code)
    ? t(`learnerMemoryPanel.error.${error.code}` as MessageKey)
    : t("learnerMemoryPanel.error.unavailable");
}
type ReadyProps = LearnerMemoryPanelProps & {
  account: NonNullable<LearnerMemoryPanelProps["account"]>;
  enrollment: NonNullable<LearnerMemoryPanelProps["enrollment"]>;
  episodeId: string;
};
function MemoryPanel({
  account,
  enrollment,
  api,
  episodeId,
  onRevision,
}: ReadyProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const ltr = useLtr();
  const scope: MemoryScope = {
    enrollmentId: enrollment.enrollmentId,
    courseDigest: enrollment.courseDigest,
    episodeId,
    ...(enrollment.workspaceId ? { workspaceId: enrollment.workspaceId } : {}),
  };
  const [snapshot, setSnapshot] = useState<MemorySnapshot>();
  const [draft, setDraft] = useState<MemoryProfile>();
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [fatal, setFatal] = useState("");
  const [needsRefresh, setNeedsRefresh] = useState(false),
    [compared, setCompared] = useState(false);
  const [query, setQuery] = useState(""),
    [kind, setKind] = useState<MemoryHistoryKind>("all");
  const [searched, setSearched] = useState<{
    q: string;
    kind: MemoryHistoryKind;
  }>();
  const [history, setHistory] = useState<MemoryHistory>(),
    [historyLoading, setHistoryLoading] = useState(false);
  const [changes, setChanges] = useState<MemoryChanges>(),
    [changesLoading, setChangesLoading] = useState(false);
  const [historyError, setHistoryError] = useState(""),
    [changesError, setChangesError] = useState("");
  const generation = useRef(0),
    writeLock = useRef(false);
  const loadAbort = useRef<AbortController | null>(null),
    historyAbort = useRef<AbortController | null>(null),
    changesAbort = useRef<AbortController | null>(null);
  const notifyRevision = useRef(onRevision);
  notifyRevision.current = onRevision;
  const objectiveTitle = (id: string) =>
    enrollment.course.objectives.find((row) => row.id === id)?.description ??
    id;
  const lessonTitle =
    enrollment.course.chapters
      .flatMap((chapter) => chapter.episodes)
      .find((row) => row.id === episodeId)?.title ?? episodeId;
  const dirty =
    !!draft &&
    !!snapshot &&
    JSON.stringify(draft) !== JSON.stringify(cleanProfile(snapshot.selfReport));
  const uncertain = api.pending(scope);
  const externalChange = !!snapshot && enrollment.revision > snapshot.revision;
  const disabled =
    busy ||
    loading ||
    !!uncertain ||
    needsRefresh ||
    externalChange ||
    !snapshot;

  function handleError(caught: unknown) {
    if (
      caught instanceof CourseApiError &&
      ([401, 403, 410].includes(caught.status) ||
        (caught.status === 404 &&
          caught.code !== "PROPOSAL_NOT_FOUND" &&
          caught.code !== "EVIDENCE_NOT_FOUND"))
    ) {
      generation.current++;
      loadAbort.current?.abort();
      historyAbort.current?.abort();
      changesAbort.current?.abort();
      setSnapshot(undefined);
      setDraft(undefined);
      setHistory(undefined);
      setChanges(undefined);
      setBusy(false);
      setFatal(
        caught.status === 401 || caught.status === 403
          ? errorCopy(caught, t)
          : t("learnerMemoryPanel.fatal.enrollmentUnavailable"),
      );
    }
    setError(errorCopy(caught, t));
    if (
      caught instanceof CourseApiError &&
      [
        "STALE_REVISION",
        "PROPOSAL_SOURCE_CHANGED",
        "PROPOSAL_NOT_FOUND",
        "IDEMPOTENCY_CONFLICT",
        "EVIDENCE_NOT_FOUND",
        "EVIDENCE_CONTROL_UNCHANGED",
        "EVIDENCE_INVALIDATED",
      ].includes(caught.code)
    )
      setNeedsRefresh(true);
  }
  async function refresh(keepDraft: boolean, afterSave = false) {
    loadAbort.current?.abort();
    const abort = new AbortController(),
      version = generation.current;
    loadAbort.current = abort;
    setLoading(true);
    try {
      const saved = await api.load(scope, abort.signal);
      if (abort.signal.aborted || version !== generation.current) return;
      setSnapshot(saved);
      setDraft((current) =>
        keepDraft && current ? current : cleanProfile(saved.selfReport),
      );
      setFatal("");
      setError("");
      setNeedsRefresh(false);
      setCompared(keepDraft);
      if (afterSave)
        setNotice(t("learnerMemoryPanel.notice.saved"));
      else if (keepDraft) setNotice(t("learnerMemoryPanel.notice.refreshed"));
    } catch (caught) {
      if (abort.signal.aborted || version !== generation.current) return;
      handleError(caught);
      setNeedsRefresh(true);
      if (afterSave)
        setNotice(t("learnerMemoryPanel.notice.savedRefresh"));
    } finally {
      if (loadAbort.current === abort) setLoading(false);
    }
  }
  useEffect(() => {
    generation.current++;
    setSnapshot(undefined);
    setDraft(undefined);
    setHistory(undefined);
    setChanges(undefined);
    void refresh(false);
    return () => {
      generation.current++;
      loadAbort.current?.abort();
      historyAbort.current?.abort();
      changesAbort.current?.abort();
    };
  }, [api]); // Scope/account changes remount this inner panel before any private state can paint.

  async function perform(
    operation: () => Promise<Pick<MemoryReceipt, "revision">>,
    keepDraft: boolean,
  ): Promise<boolean> {
    if (writeLock.current) return false;
    const version = generation.current;
    writeLock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const receipt = await operation();
      if (version !== generation.current) return false;
      setNeedsRefresh(true);
      changesAbort.current?.abort();
      setChanges(undefined);
      setChangesError("");
      setChangesLoading(false);
      await refresh(keepDraft, true);
      if (version === generation.current)
        notifyRevision.current?.(receipt.revision);
      return version === generation.current;
    } catch (caught) {
      if (version === generation.current) handleError(caught);
      return false;
    } finally {
      writeLock.current = false;
      if (version === generation.current) setBusy(false);
    }
  }
  async function controlEvidence(
    evidenceId: string,
    action: EvidenceControlAction,
    reason?: string,
  ) {
    if (!snapshot) return false;
    const done = await perform(
      () =>
        api.controlEvidence(
          scope,
          snapshot.revision,
          evidenceId,
          action,
          reason,
        ),
      true,
    );
    if (done && history) void search();
    return done;
  }
  async function search(before?: string) {
    historyAbort.current?.abort();
    const abort = new AbortController(),
      version = generation.current;
    historyAbort.current = abort;
    const request = before && searched ? searched : { q: query.trim(), kind };
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const result = await api.history(
        scope,
        { ...request, ...(before ? { before } : {}) },
        abort.signal,
      );
      if (abort.signal.aborted || version !== generation.current) return;
      setHistory(result);
      setSearched(request);
    } catch (caught) {
      if (abort.signal.aborted || version !== generation.current) return;
      setHistoryError(errorCopy(caught, t));
      if (
        caught instanceof CourseApiError &&
        [401, 403, 404, 410].includes(caught.status)
      )
        handleError(caught);
    } finally {
      if (historyAbort.current === abort) setHistoryLoading(false);
    }
  }
  async function showChanges(before?: string) {
    changesAbort.current?.abort();
    const abort = new AbortController(),
      version = generation.current;
    changesAbort.current = abort;
    setChangesLoading(true);
    setChangesError("");
    try {
      const result = await api.changes(scope, before, abort.signal);
      if (!abort.signal.aborted && version === generation.current)
        setChanges(result);
    } catch (caught) {
      if (abort.signal.aborted || version !== generation.current) return;
      setChangesError(errorCopy(caught, t));
      if (
        caught instanceof CourseApiError &&
        [401, 403, 404, 410].includes(caught.status)
      )
        handleError(caught);
    } finally {
      if (changesAbort.current === abort) setChangesLoading(false);
    }
  }
  const [declaredValid, setDeclaredValid] = useState(true);
  function edit(next: MemoryProfile) {
    setDraft(next);
    setNotice("");
  }
  const save = () => {
    if (disabled || !draft || !snapshot) return;
    if (!declaredValid) {
      setError(t("profileDetails.fixFirst"));
      return;
    }
    if (draft.priorKnowledge.some((row) => !row.statement.trim())) {
      setError(t("learnerMemoryPanel.error.emptyClaim"));
      return;
    }
    void perform(() => api.save(scope, snapshot.revision, draft), false);
  };

  const reserve = useReservedHeight(
    `memory:${enrollment.enrollmentId}`,
    !loading || !!snapshot,
  );
  if (fatal)
    return (
      <View style={local.panel}>
        <Notice error>{fatal}</Notice>
        <Button
          label={t("learnerMemoryPanel.checkAccess")}
          onPress={() => void refresh(false)}
          disabled={loading}
        />
      </View>
    );
  return (
    <View
      style={[local.panel, { minHeight: reserve.minHeight }]}
      onLayout={reserve.onLayout}
    >
      <View style={styles.spread}>
        <View style={local.grow}>
          <Text style={styles.eyebrow}>
            {t("learnerMemoryPanel.header.eyebrow")}
          </Text>
          <Text accessibilityRole="header" style={styles.title}>
            {t("learnerMemoryPanel.header.title")}
          </Text>
          <Text style={styles.body}>{t("learnerMemoryPanel.header.body")}</Text>
        </View>
        <View style={local.badge}>
          <Badge label={
              account.displayName || t("learnerMemoryPanel.accountFallback")
            } tone="lilac" />
          {loading && snapshot && (
            // A refresh keeps the loaded memory on screen. Its indicator sits
            // under the badge, inside the header's height, instead of adding a
            // row above the memory that would push its controls down.
            <>
              <ActivityIndicator
                accessibilityLabel={t("learnerMemoryPanel.loading.label")}
              />
              <Text accessibilityLiveRegion="polite" style={local.offscreen}>
                {t("learnerMemoryPanel.loading.text")}
              </Text>
            </>
          )}
        </View>
      </View>
      <Text style={styles.small}>
        {t("learnerMemoryPanel.lesson", { lesson: lessonTitle })}
      </Text>
      {loading && !snapshot && (
        <View style={styles.row}>
          <ActivityIndicator
                accessibilityLabel={t("learnerMemoryPanel.loading.label")}
              />
          <Text accessibilityLiveRegion="polite" style={styles.small}>
            {t("learnerMemoryPanel.loading.text")}
          </Text>
        </View>
      )}
      {!!error && <Notice error>{error}</Notice>}
      {!!notice && <Notice>{notice}</Notice>}
      {uncertain && (
        <View style={local.callout}>
          <Notice>{t("learnerMemoryPanel.uncertain.notice")}</Notice>
          <Button
            label={t("learnerMemoryPanel.uncertain.retry")}
            disabled={busy || loading}
            onPress={() =>
              void perform(
                () => api.retry(scope),
                uncertain !== "profile" && dirty,
              )
            }
          />
        </View>
      )}
      {(needsRefresh || externalChange || (!snapshot && !loading)) && (
        <View style={local.callout}>
          {externalChange && (
            <Notice>{t("learnerMemoryPanel.externalChange")}</Notice>
          )}
          <Button
            label={t(
              draft
                ? "learnerMemoryPanel.refresh.keepDraft"
                : "learnerMemoryPanel.refresh.retry",
            )}
            disabled={busy || loading}
            onPress={() => void refresh(!!draft)}
          />
        </View>
      )}
      {snapshot && draft && (
        <>
          <Section
            eyebrow={t("learnerMemoryPanel.evidence.eyebrow")}
            title={t("learnerMemoryPanel.evidence.title")}
          >
            <Text style={styles.body}>
              {t("learnerMemoryPanel.evidence.body")}
            </Text>
            {snapshot.understanding.length === 0 && (
              <Text style={styles.body}>
                {t("learnerMemoryPanel.evidence.empty")}
              </Text>
            )}
            {snapshot.understanding.map((row) => (
              <View key={row.objectiveId} style={local.inset}>
                <Text accessibilityRole="header" style={styles.heading}>
                  {objectiveTitle(row.objectiveId)}
                </Text>
                <Badge
                  label={t(`learnerMemoryPanel.skill.${row.status}` as MessageKey)}
                  tone={
                    row.status === "demonstrated" || row.status === "retained"
                      ? "mint"
                      : row.status === "needs_review" ||
                          row.status === "disputed"
                        ? "sand"
                        : "neutral"
                  }
                />
                {!!row.explanation && (
                  <Text style={styles.small}>{row.explanation}</Text>
                )}
                {row.gateId !== null ? (
                  <Text style={styles.body}>
                    {t("learnerMemoryPanel.families", {
                      count: row.independentFamilies,
                      truncated: row.familiesTruncated ? "true" : "false",
                      required: row.requiredFamilies,
                    })}{" "}
                    {retentionCopy(row, i18n)}
                  </Text>
                ) : (
                  <Text style={styles.body}>
                    {t("learnerMemoryPanel.noGate")}
                  </Text>
                )}
                {row.practiceAttempts > 0 && !row.demonstrated && (
                  <Text style={styles.small}>
                    {t("learnerMemoryPanel.practice", {
                      count: row.practiceAttempts,
                    })}
                  </Text>
                )}
                {row.openDisputes > 0 && (
                  <Text style={styles.small}>
                    {t("learnerMemoryPanel.openDispute")}
                  </Text>
                )}
                <Disclosure
                  showLabel={t("learnerMemoryPanel.evidenceRefs.show", {
                    objective: objectiveTitle(row.objectiveId),
                  })}
                  hideLabel={t("learnerMemoryPanel.evidenceRefs.hide", {
                    objective: objectiveTitle(row.objectiveId),
                  })}
                >
                  {row.evidenceRefs.length === 0 && (
                    <Text style={styles.small}>
                      {t("learnerMemoryPanel.evidenceRefs.empty")}
                    </Text>
                  )}
                  {row.evidenceRefs.map((ref) => (
                    <View key={ref.evidenceId} style={local.references}>
                      <Reference
                        label={t("learnerMemoryPanel.ref.evidence")}
                        value={ref.evidenceId}
                      />
                      <Reference
                        label={t("learnerMemoryPanel.ref.attempt")}
                        value={ref.attemptId}
                      />
                      <Reference
                        label={t("learnerMemoryPanel.ref.courseDigest")}
                        value={ref.courseDigest}
                      />
                      {ref.decidedBy && ref.recordedAt && (
                        <Text style={styles.small}>
                          {t("profileDetails.provenance", {
                            by: t(`profileDetails.decidedBy.${ref.decidedBy}` as MessageKey),
                            date: i18n.date(ref.recordedAt, "medium"),
                          })}
                        </Text>
                      )}
                      <EvidenceControls
                        evidenceId={ref.evidenceId}
                        disputed={!!ref.disputed}
                        excluded={!!ref.excluded}
                        disabled={disabled}
                        onControl={controlEvidence}
                      />
                    </View>
                  ))}
                  {row.gateId !== null &&
                    row.evidenceRefsTruncated && (
                      <Text style={styles.small}>
                        {t("learnerMemoryPanel.evidenceRefs.truncated")}
                      </Text>
                    )}
                </Disclosure>
              </View>
            ))}
            {snapshot.scope.objectivesTruncated && (
              <Notice>{t("learnerMemoryPanel.objectivesTruncated")}</Notice>
            )}
          </Section>

          <View style={local.columns}>
            <View style={local.column}>
              <Section
                eyebrow={t("learnerMemoryPanel.profile.eyebrow")}
                title={t("learnerMemoryPanel.profile.title")}
              >
                <Badge
                  label={t(
                    dirty
                      ? "learnerMemoryPanel.profile.unsaved"
                      : "learnerMemoryPanel.profile.saved",
                  )}
                  tone={dirty ? "sand" : "neutral"}
                />
                <Text style={styles.body}>
                  {t("learnerMemoryPanel.profile.body")}
                </Text>
                <ChoiceList
                  label={t("learnerMemoryPanel.pace.label")}
                  options={[
                    { id: "", label: t("learnerMemoryPanel.pace.none") },
                    ...paceOptions(t),
                  ]}
                  value={draft.preferences.pace ?? ""}
                  disabled={disabled}
                  onChange={(value) =>
                    edit({
                      ...draft,
                      preferences: {
                        ...draft.preferences,
                        pace: value
                          ? (value as MemoryProfile["preferences"]["pace"])
                          : undefined,
                      },
                    })
                  }
                />
                <ChoiceList
                  label={t("learnerMemoryPanel.style.label")}
                  options={[
                    { id: "", label: t("learnerMemoryPanel.style.none") },
                    ...styleOptions(t),
                  ]}
                  value={draft.preferences.explanationStyle ?? ""}
                  disabled={disabled}
                  onChange={(value) =>
                    edit({
                      ...draft,
                      preferences: {
                        ...draft.preferences,
                        explanationStyle: value
                          ? (value as MemoryProfile["preferences"]["explanationStyle"])
                          : undefined,
                      },
                    })
                  }
                />
                <Field
                  label={t("learnerMemoryPanel.goal.label")}
                  multiline
                  maxLength={2000}
                  value={draft.preferences.goal ?? ""}
                  editable={!disabled}
                  onChangeText={(goal) =>
                    edit({
                      ...draft,
                      preferences: { ...draft.preferences, goal },
                    })
                  }
                />
                <Text style={styles.small}>
                  {t("learnerMemoryPanel.goal.note")}
                </Text>
                <DeclaredProfileFields
                  draft={draft}
                  disabled={disabled}
                  onChange={edit}
                  onValidity={setDeclaredValid}
                />
                <Text accessibilityRole="header" style={styles.heading}>
                  {t("learnerMemoryPanel.prior.heading")}
                </Text>
                <Text style={styles.small}>
                  {t("learnerMemoryPanel.prior.note")}
                </Text>
                {draft.priorKnowledge.length === 0 && (
                  <Text style={styles.small}>
                    {t("learnerMemoryPanel.prior.empty")}
                  </Text>
                )}
                {draft.priorKnowledge.map((row) => (
                  <View key={row.objectiveId} style={local.inset}>
                    <Field
                      label={t("learnerMemoryPanel.prior.field", {
                        objective: objectiveTitle(row.objectiveId),
                      })}
                      value={row.statement}
                      multiline
                      maxLength={500}
                      editable={!disabled}
                      onChangeText={(statement) =>
                        edit({
                          ...draft,
                          priorKnowledge: draft.priorKnowledge.map((old) =>
                            old.objectiveId === row.objectiveId
                              ? { ...old, statement }
                              : old,
                          ),
                        })
                      }
                    />
                    <Button
                      label={t("learnerMemoryPanel.prior.remove")}
                      accessibilityLabel={t("learnerMemoryPanel.prior.removeFor", {
                        objective: objectiveTitle(row.objectiveId),
                      })}
                      kind="quiet"
                      disabled={disabled}
                      onPress={() =>
                        edit({
                          ...draft,
                          priorKnowledge: draft.priorKnowledge.filter(
                            (old) => old.objectiveId !== row.objectiveId,
                          ),
                        })
                      }
                    />
                  </View>
                ))}
                {draft.priorKnowledge.length < 20 &&
                  snapshot.scope.objectiveIds
                    .filter(
                      (id) =>
                        !draft.priorKnowledge.some(
                          (row) => row.objectiveId === id,
                        ),
                    )
                    .map((id) => (
                      <Button
                        key={id}
                        label={t("learnerMemoryPanel.prior.add", {
                          objective: objectiveTitle(id),
                        })}
                        disabled={disabled}
                        onPress={() =>
                          edit({
                            ...draft,
                            priorKnowledge: [
                              ...draft.priorKnowledge,
                              { objectiveId: id, statement: "" },
                            ],
                          })
                        }
                      />
                    ))}
                <Text style={styles.small}>
                  {t("learnerMemoryPanel.prior.removalNote")}
                </Text>
                <Field
                  label={t("learnerMemoryPanel.thoughts.label")}
                  value={draft.thoughts}
                  multiline
                  maxLength={1000}
                  editable={!disabled}
                  onChangeText={(thoughts) => edit({ ...draft, thoughts })}
                />
                <Text style={styles.small}>
                  {t("learnerMemoryPanel.thoughts.note")}
                </Text>
                {compared && dirty && (
                  <Disclosure
                    showLabel={t("learnerMemoryPanel.compare.show")}
                    hideLabel={t("learnerMemoryPanel.compare.hide")}
                  >
                    <ProfileSummary
                      value={snapshot.selfReport}
                      title={objectiveTitle}
                    />
                  </Disclosure>
                )}
                <View style={styles.row}>
                  <Button
                    label={t(
                      busy
                        ? "learnerMemoryPanel.save.busy"
                        : "learnerMemoryPanel.save.idle",
                    )}
                    kind="primary"
                    disabled={disabled || !dirty}
                    onPress={save}
                  />
                  <Button
                    label={t("learnerMemoryPanel.discard")}
                    kind="quiet"
                    disabled={disabled || !dirty}
                    onPress={() => {
                      setDraft(cleanProfile(snapshot.selfReport));
                      setCompared(false);
                      setError("");
                      setNotice(t("learnerMemoryPanel.discarded"));
                    }}
                  />
                </View>
              </Section>
            </View>
            <View style={local.column}>
              <Section
                eyebrow={t("learnerMemoryPanel.suggestions.eyebrow")}
                title={t("learnerMemoryPanel.suggestions.title")}
              >
                <Text style={styles.body}>
                  {t("learnerMemoryPanel.suggestions.body")}
                </Text>
                {snapshot.suggestions.items.length === 0 && (
                  <View style={local.inset}>
                    <Text style={styles.heading}>
                      {t("learnerMemoryPanel.suggestions.emptyTitle")}
                    </Text>
                    <Text style={styles.body}>
                      {t("learnerMemoryPanel.suggestions.emptyBody")}
                    </Text>
                  </View>
                )}
                {snapshot.suggestions.items.map((proposal) => (
                  <ProposalCard
                    key={proposal.proposalId}
                    proposal={proposal}
                    disabled={disabled}
                    objectiveTitle={objectiveTitle}
                    objectives={enrollment.course.objectives.filter((row) =>
                      snapshot.scope.objectiveIds.includes(row.id),
                    )}
                    onDecide={(decision) =>
                      perform(
                        () =>
                          api.decide(
                            scope,
                            snapshot.revision,
                            proposal.proposalId,
                            decision,
                          ),
                        dirty,
                      )
                    }
                  />
                ))}
                {snapshot.suggestions.truncated && (
                  <Notice>{t("learnerMemoryPanel.suggestions.truncated")}</Notice>
                )}
              </Section>
            </View>
          </View>

          <Section
            eyebrow={t("learnerMemoryPanel.history.eyebrow")}
            title={t("learnerMemoryPanel.history.title")}
          >
            <Text style={styles.body}>
              {t("learnerMemoryPanel.history.body", { lesson: lessonTitle })}
            </Text>
            <Field
              label={t("learnerMemoryPanel.history.search")}
              value={query}
              maxLength={100}
              onChangeText={setQuery}
              placeholder={t("learnerMemoryPanel.history.placeholder")}
              returnKeyType="search"
              onSubmitEditing={() => void search()}
              editable={!historyLoading}
            />
            <View style={styles.row}>
              {(
                [
                  ["all", t("learnerMemoryPanel.history.kind.all")],
                  ["questions", t("learnerMemoryPanel.history.kind.questions")],
                  ["evidence", t("learnerMemoryPanel.history.kind.evidence")],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  label={label}
                  selected={kind === value}
                  disabled={historyLoading}
                  onPress={() => setKind(value)}
                />
              ))}
            </View>
            <Button
              label={t(
                historyLoading
                  ? "learnerMemoryPanel.history.searching"
                  : "learnerMemoryPanel.history.searchButton",
              )}
              onPress={() => void search()}
              disabled={historyLoading}
            />
            {!!historyError && <Notice error>{historyError}</Notice>}
            {history && (
              <View style={local.stack}>
                <Text accessibilityLiveRegion="polite" style={styles.small}>
                  {searched?.q
                    ? t("learnerMemoryPanel.history.countFor", {
                        count: history.items.length,
                        query: searched.q,
                      })
                    : t("learnerMemoryPanel.history.count", {
                        count: history.items.length,
                      })}
                </Text>
                {history.items.length === 0 && (
                  <Notice>
                    {t(
                      history.nextCursor
                        ? "learnerMemoryPanel.history.noMatchesMore"
                        : "learnerMemoryPanel.history.noMatches",
                    )}
                  </Notice>
                )}
                {history.items.map((item) => (
                  <View key={item.eventId} style={local.inset}>
                    <Badge
                      label={
                        item.kind === "questions"
                          ? t("learnerMemoryPanel.history.yourQuestion")
                          : t(
                              item.passed
                                ? "learnerMemoryPanel.history.passed"
                                : "learnerMemoryPanel.history.notPassed",
                              { mode: item.mode },
                            )
                      }
                      tone="neutral"
                    />
                    <Text selectable style={styles.body}>
                      {item.text || t("learnerMemoryPanel.history.noText")}
                    </Text>
                    <Disclosure
                      showLabel={t("learnerMemoryPanel.historyRefs.show", {
                        cursor: ltr(item.cursor),
                      })}
                      hideLabel={t("learnerMemoryPanel.historyRefs.hide", {
                        cursor: ltr(item.cursor),
                      })}
                    >
                      <Reference
                        label={t("learnerMemoryPanel.ref.event")}
                        value={item.eventId}
                      />
                      {item.kind === "questions" ? (
                        <Reference
                          label={t("learnerMemoryPanel.ref.message")}
                          value={item.messageId}
                        />
                      ) : (
                        <>
                          <Reference
                            label={t("learnerMemoryPanel.ref.attempt")}
                            value={item.attemptId}
                          />
                          {item.evidenceRefs.map((ref) => (
                            <View key={ref.evidenceId}>
                              <Reference
                                label={t("learnerMemoryPanel.ref.evidence")}
                                value={ref.evidenceId}
                              />
                              <Text style={styles.small}>
                                {t(
                                  ref.invalidated
                                    ? "learnerMemoryPanel.history.invalidated"
                                    : ref.independent
                                      ? "learnerMemoryPanel.history.independent"
                                      : "learnerMemoryPanel.history.notIndependent",
                                )}
                              </Text>
                              <EvidenceControls
                                evidenceId={ref.evidenceId}
                                disputed={!!ref.disputed}
                                excluded={!!ref.excluded}
                                invalidated={ref.invalidated}
                                disabled={disabled}
                                onControl={controlEvidence}
                              />
                            </View>
                          ))}
                          {item.evidenceRefsTruncated && (
                            <Text style={styles.small}>
                              {t("learnerMemoryPanel.history.moreRefs")}
                            </Text>
                          )}
                        </>
                      )}
                    </Disclosure>
                  </View>
                ))}
                <Text style={styles.small}>
                  {t("learnerMemoryPanel.history.coverage")}
                </Text>
                {history.nextCursor && (
                  <Button
                    label={t("learnerMemoryPanel.history.earlier")}
                    disabled={historyLoading}
                    onPress={() => void search(history.nextCursor!)}
                  />
                )}
              </View>
            )}
          </Section>
          <Section
            eyebrow={t("learnerMemoryPanel.changes.eyebrow")}
            title={t("learnerMemoryPanel.changes.title")}
          >
            <Text style={styles.body}>
              {t("learnerMemoryPanel.changes.body")}
            </Text>
            <Button
              label={t(
                changesLoading
                  ? "learnerMemoryPanel.changes.loading"
                  : "learnerMemoryPanel.changes.view",
              )}
              onPress={() => void showChanges()}
              disabled={changesLoading}
            />
            {!!changesError && <Notice error>{changesError}</Notice>}
            {changes?.items.length === 0 && (
              <Notice>{t("learnerMemoryPanel.changes.empty")}</Notice>
            )}
            {changes?.items.map((change) => (
              <View key={change.id} style={local.inset}>
                <Text style={styles.heading}>
                  {changeLabel(change.action, i18n)}
                </Text>
                <Text style={styles.small}>
                  {t(
                    change.actorKind === "learner"
                      ? "learnerMemoryPanel.change.byLearner"
                      : "learnerMemoryPanel.change.byService",
                    { when: i18n.dateTime(change.createdAt) },
                  )}
                </Text>
                {change.data.reason ? (
                  <Text selectable style={styles.body}>
                    {change.data.reason}
                  </Text>
                ) : null}
                <Disclosure
                  showLabel={t("learnerMemoryPanel.changeDetails.show", {
                    cursor: ltr(change.cursor),
                  })}
                  hideLabel={t("learnerMemoryPanel.changeDetails.hide", {
                    cursor: ltr(change.cursor),
                  })}
                >
                  {change.data.profile && (
                    <ProfileSummary
                      value={change.data.profile}
                      title={objectiveTitle}
                    />
                  )}
                  {(change.data.correction ??
                    change.data.suggestion ??
                    change.data.originalSuggestion) && (
                    <Text style={styles.body}>
                      {suggestionLabel(
                        (change.data.correction ??
                          change.data.suggestion ??
                          change.data.originalSuggestion)!,
                        objectiveTitle,
                        t,
                      )}
                    </Text>
                  )}
                  <Reference
                    label={t("learnerMemoryPanel.ref.change")}
                    value={change.id}
                  />
                  <Reference
                    label={t("learnerMemoryPanel.ref.event")}
                    value={change.eventId}
                  />
                  {change.data.sourceEventRefs?.map((ref) => (
                    <View key={ref.eventId}>
                      <Reference
                        label={t("learnerMemoryPanel.ref.sourceEvent")}
                        value={ref.eventId}
                      />
                      <Reference
                        label={t("learnerMemoryPanel.ref.sourceDigest")}
                        value={ref.digest}
                      />
                    </View>
                  ))}
                </Disclosure>
              </View>
            ))}
            {changes?.nextCursor && (
              <Button
                label={t("learnerMemoryPanel.changes.earlier")}
                disabled={changesLoading}
                onPress={() => void showChanges(changes.nextCursor!)}
              />
            )}
          </Section>
        </>
      )}
    </View>
  );
}

function retentionCopy(
  row: MemoryUnderstanding,
  i18n: Pick<LearnerTranslator, "t" | "date">,
) {
  const { t } = i18n;
  if (row.retention === "retained")
    return t("learnerMemoryPanel.retention.retained");
  if (row.retention === "needs_review")
    return t("learnerMemoryPanel.retention.needsReview");
  if (row.retention === "scheduled")
    return row.retentionDueAt
      ? t("learnerMemoryPanel.retention.scheduledOn", {
          date: i18n.date(row.retentionDueAt),
        })
      : t("learnerMemoryPanel.retention.scheduled");
  return t("learnerMemoryPanel.retention.none");
}
/** History actions are dotted codes (`proposal.accepted`); an unknown one shows as is. */
function changeLabel(action: string, i18n: Pick<LearnerTranslator, "t" | "has">) {
  const key = `learnerMemoryPanel.change.${action}` as MessageKey;
  return i18n.has(key) ? i18n.t(key) : action;
}
function suggestionLabel(
  value: MemorySuggestion,
  title: (id: string) => string,
  t: Translate,
) {
  if (value.kind === "pace")
    return t("learnerMemoryPanel.suggested.pace", {
      value:
        paceOptions(t).find((row) => row.id === value.value)?.label ??
        value.value,
    });
  if (value.kind === "explanation_style")
    return t("learnerMemoryPanel.suggested.style", {
      value:
        styleOptions(t).find((row) => row.id === value.value)?.label ??
        value.value,
    });
  return t("learnerMemoryPanel.suggested.review", {
    objective: title(value.objectiveId),
  });
}
function ProposalCard({
  proposal,
  disabled,
  objectives,
  objectiveTitle,
  onDecide,
}: {
  proposal: MemoryProposal;
  disabled: boolean;
  objectives: readonly { id: string; description: string }[];
  objectiveTitle: (id: string) => string;
  onDecide: (decision: MemoryDecision) => Promise<boolean>;
}) {
  const t = useT();
  const ltr = useLtr();
  const [editing, setEditing] = useState<"correct" | "dispute">();
  const [correction, setCorrection] = useState(proposal.suggestion),
    [reason, setReason] = useState("");
  const [editingRevision, setEditingRevision] = useState(proposal.decisionId);
  const [reviewBusy, setReviewBusy] = useState(false);
  const locked = disabled || reviewBusy;
  const actionsRef = useRef<View>(null);
  function closeReview() {
    setEditing(undefined);
    setReason("");
    actionsRef.current?.focus();
  }
  async function decide(decision: MemoryDecision) {
    if (locked) return;
    setReviewBusy(true);
    try {
      if (await onDecide(decision)) closeReview();
    } finally {
      setReviewBusy(false);
    }
  }
  const options =
    correction.kind === "pace"
      ? paceOptions(t)
      : correction.kind === "explanation_style"
        ? styleOptions(t)
        : objectives.map((row) => ({ id: row.id, label: row.description }));
  const status = t(
    `learnerMemoryPanel.proposal.status.${proposal.status}` as MessageKey,
  );
  return (
    <View style={local.inset}>
      <Badge
        label={status}
        tone={proposal.status === "pending" ? "lilac" : "neutral"}
      />
      <Text accessibilityRole="header" style={styles.heading}>
        {suggestionLabel(proposal.suggestion, objectiveTitle, t)}
      </Text>
      <Text style={styles.small}>
        {proposal.origin?.kind !== "connected_agent"
          ? t("learnerMemoryPanel.proposal.fromCourse")
          : proposal.origin.label
            ? t("learnerMemoryPanel.proposal.fromAgent", {
                agent: proposal.origin.label,
              })
            : t("learnerMemoryPanel.proposal.fromAgentUnnamed")}
      </Text>
      <Disclosure
        showLabel={t("learnerMemoryPanel.sourceRefs.show", {
          id: ltr(proposal.proposalId),
        })}
        hideLabel={t("learnerMemoryPanel.sourceRefs.hide", {
          id: ltr(proposal.proposalId),
        })}
      >
        <Reference
          label={t("learnerMemoryPanel.ref.proposal")}
          value={proposal.proposalId}
        />
        <Text style={styles.small}>
          {t("learnerMemoryPanel.proposal.original", {
            suggestion: suggestionLabel(
              proposal.originalSuggestion,
              objectiveTitle,
              t,
            ),
          })}
        </Text>
        {proposal.sourceEventRefs.map((ref) => (
          <View key={ref.eventId} style={local.references}>
            <Reference
              label={t("learnerMemoryPanel.ref.sourceEvent")}
              value={ref.eventId}
            />
            <Reference
              label={t("learnerMemoryPanel.ref.eventType")}
              value={ref.eventType}
            />
            <Reference
              label={t("learnerMemoryPanel.ref.recordedDigest")}
              value={ref.digest}
            />
          </View>
        ))}
        {proposal.decisionId && (
          <Reference
            label={t("learnerMemoryPanel.ref.latestDecision")}
            value={proposal.decisionId}
          />
        )}
      </Disclosure>
      {proposal.status === "source_revoked" ? (
        <Text style={styles.small}>
          {t("learnerMemoryPanel.proposal.revokedNote")}
        </Text>
      ) : (
      <View
        ref={actionsRef}
        tabIndex={-1}
        accessibilityRole="toolbar"
        accessibilityLabel={t("learnerMemoryPanel.proposal.actions")}
        style={styles.row}
      >
        {proposal.status === "pending" || proposal.status === "disputed" ? (
          <Button
            label={t("learnerMemoryPanel.proposal.accept")}
            disabled={locked || !!editing}
            onPress={() => void decide({ action: "accept" })}
          />
        ) : null}
        <Button
          label={t("learnerMemoryPanel.proposal.correct")}
          disabled={locked || !!editing}
          onPress={() => {
            setCorrection(proposal.suggestion);
            setEditingRevision(proposal.decisionId);
            setEditing("correct");
          }}
        />
        {proposal.status !== "disputed" && (
          <Button
            label={t("learnerMemoryPanel.proposal.dispute")}
            disabled={locked || !!editing}
            kind="quiet"
            onPress={() => {
              setEditingRevision(proposal.decisionId);
              setEditing("dispute");
            }}
          />
        )}
      </View>
      )}
      {editing && (
        <View style={local.stack}>
          {editingRevision !== proposal.decisionId && (
            <Notice>{t("learnerMemoryPanel.proposal.changed")}</Notice>
          )}
          <Text style={styles.body}>
            {t(
              editing === "correct"
                ? "learnerMemoryPanel.proposal.correctPrompt"
                : "learnerMemoryPanel.proposal.disputePrompt",
            )}
          </Text>
          {editing === "correct" && (
            <ChoiceList
              label={t("learnerMemoryPanel.proposal.correctionField")}
              options={options}
              value={
                correction.kind === "review_objective"
                  ? correction.objectiveId
                  : correction.value
              }
              disabled={locked}
              onChange={(value) =>
                setCorrection(
                  correction.kind === "review_objective"
                    ? { ...correction, objectiveId: value }
                    : ({ ...correction, value } as MemorySuggestion),
                )
              }
            />
          )}
          <Field
            label={t("learnerMemoryPanel.proposal.note")}
            multiline
            maxLength={500}
            value={reason}
            editable={!locked}
            onChangeText={setReason}
          />
          <View style={styles.row}>
            <Button
              label={t(
                editing === "correct"
                  ? "learnerMemoryPanel.proposal.saveCorrection"
                  : "learnerMemoryPanel.proposal.confirmDispute",
              )}
              kind="primary"
              disabled={locked}
              onPress={() =>
                void decide(
                  editing === "correct"
                    ? { action: "correct", correction, reason }
                    : { action: "dispute", reason },
                )
              }
            />
            <Button
              label={t("learnerMemoryPanel.proposal.cancel")}
              kind="quiet"
              disabled={locked}
              onPress={closeReview}
            />
          </View>
        </View>
      )}
    </View>
  );
}
/** Dispute a result (asks staff to look again) or keep it out of what the
 * companion and supervisor are given. Neither changes credit. */
function EvidenceControls({
  evidenceId,
  disputed,
  excluded,
  invalidated = false,
  disabled,
  onControl,
}: {
  evidenceId: string;
  disputed: boolean;
  excluded: boolean;
  invalidated?: boolean;
  disabled: boolean;
  onControl: (
    evidenceId: string,
    action: EvidenceControlAction,
    reason?: string,
  ) => Promise<boolean>;
}) {
  const [writing, setWriting] = useState(false),
    [reason, setReason] = useState("");
  const t = useT();
  const short = useLtr()(evidenceId.slice(0, 8));
  return (
    <View style={local.stack}>
      <Text style={styles.small}>
        {t(
          disputed
            ? excluded
              ? "learnerMemoryPanel.evidenceUse.disputedExcluded"
              : "learnerMemoryPanel.evidenceUse.disputedIncluded"
            : excluded
              ? "learnerMemoryPanel.evidenceUse.excluded"
              : "learnerMemoryPanel.evidenceUse.included",
        )}
      </Text>
      {writing ? (
        <View style={local.stack}>
          <Field
            label={t("learnerMemoryPanel.dispute.why", { id: short })}
            multiline
            value={reason}
            onChangeText={setReason}
            maxLength={500}
            placeholder={t("learnerMemoryPanel.dispute.placeholder")}
          />
          <Text style={styles.small}>
            {t("learnerMemoryPanel.dispute.note")}
          </Text>
          <View style={local.actions}>
            <Button
              label={t("learnerMemoryPanel.dispute.send")}
              kind="primary"
              disabled={disabled || !reason.trim()}
              onPress={async () => {
                if (await onControl(evidenceId, "dispute", reason.trim())) {
                  setWriting(false);
                  setReason("");
                }
              }}
            />
            <Button
              label={t("learnerMemoryPanel.dispute.cancel")}
              kind="quiet"
              onPress={() => {
                setWriting(false);
                setReason("");
              }}
            />
          </View>
        </View>
      ) : (
        <View style={local.actions}>
          {disputed ? (
            <Button
              label={t("learnerMemoryPanel.dispute.withdraw", { id: short })}
              disabled={disabled}
              onPress={() => void onControl(evidenceId, "withdraw_dispute")}
            />
          ) : (
            !invalidated && (
              <Button
                label={t("learnerMemoryPanel.dispute.start", { id: short })}
                disabled={disabled}
                onPress={() => setWriting(true)}
              />
            )
          )}
          <Button
            label={t(
              excluded
                ? "learnerMemoryPanel.context.include"
                : "learnerMemoryPanel.context.exclude",
              { id: short },
            )}
            disabled={disabled}
            onPress={() =>
              void onControl(evidenceId, excluded ? "include" : "exclude")
            }
          />
        </View>
      )}
    </View>
  );
}
function ProfileSummary({
  value,
  title,
}: {
  value: MemoryProfile;
  title: (id: string) => string;
}) {
  const t = useT();
  const none = t("learnerMemoryPanel.summary.noPreference");
  return (
    <View style={local.stack}>
      <Text selectable style={styles.body}>
        {value.preferences.goal
          ? t("learnerMemoryPanel.summary.goal", {
              goal: value.preferences.goal,
            })
          : t("learnerMemoryPanel.summary.noGoal")}
      </Text>
      <Text style={styles.small}>
        {t("learnerMemoryPanel.summary.preferences", {
          pace:
            paceOptions(t).find((row) => row.id === value.preferences.pace)
              ?.label ??
            value.preferences.pace ??
            none,
          style:
            styleOptions(t).find(
              (row) => row.id === value.preferences.explanationStyle,
            )?.label ?? none,
        })}
      </Text>
      {(value.preferences.languages?.length || value.preferences.experience || value.preferences.depth || value.preferences.weeklyMinutes || value.preferences.accessibility?.length) && (
        <Text style={styles.small}>
          {[
            value.preferences.languages?.length ? t("profileDetails.summary.languages", { languages: value.preferences.languages.join(", ") }) : null,
            value.preferences.experience ? t(`profileDetails.experience.${value.preferences.experience}` as MessageKey) : null,
            value.preferences.depth ? t(`profileDetails.depth.${value.preferences.depth}` as MessageKey) : null,
            value.preferences.weeklyMinutes ? t("profileDetails.summary.minutes", { minutes: value.preferences.weeklyMinutes }) : null,
            ...(value.preferences.accessibility ?? []).map((need) => t(`profileDetails.accessibility.${need}` as MessageKey)),
          ].filter(Boolean).join(" · ")}
        </Text>
      )}
      {value.priorKnowledge.map((row) => (
        <Text key={row.objectiveId} selectable style={styles.body}>
          {t("learnerMemoryPanel.summary.claim", {
            objective: title(row.objectiveId),
            statement: row.statement,
          })}
        </Text>
      ))}
      <Text selectable style={styles.body}>
        {value.thoughts
          ? t("learnerMemoryPanel.summary.thoughts", {
              thoughts: value.thoughts,
            })
          : t("learnerMemoryPanel.summary.noThoughts")}
      </Text>
    </View>
  );
}
function Section({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={[styles.card, local.section]}>
      <Text style={styles.eyebrow}>{eyebrow}</Text>
      <Text accessibilityRole="header" style={styles.heading}>
        {title}
      </Text>
      {children}
    </View>
  );
}
function Disclosure({
  showLabel,
  hideLabel,
  children,
}: {
  showLabel: string;
  hideLabel: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={local.stack}>
      <Button
        label={open ? hideLabel : showLabel}
        selected={open}
        kind="quiet"
        onPress={() => setOpen((value) => !value)}
      />
      {open && children}
    </View>
  );
}
function Reference({ label, value }: { label: string; value: string }) {
  const t = useT();
  const ltr = useLtr();
  return (
    <Text selectable style={local.reference}>
      {t("learnerMemoryPanel.reference", { label, value: ltr(value) })}
    </Text>
  );
}
const local = StyleSheet.create({
  panel: {
    width: "100%",
    maxWidth: 1120,
    alignSelf: "center",
    gap: 22,
    paddingVertical: 16,
    minWidth: 0,
  },
  columns: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-start",
    gap: 20,
  },
  column: {
    flexBasis: 340,
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    maxWidth: "100%",
  },
  section: { minWidth: 0, padding: 20 },
  grow: { flex: 1, minWidth: 0, gap: 8 },
  badge: { alignItems: "flex-end", gap: 8 },
  offscreen: {
    position: "absolute",
    width: 1,
    height: 1,
    overflow: "hidden",
    opacity: 0,
  },
  stack: { gap: 12, minWidth: 0 },
  inset: {
    padding: 16,
    borderRadius: 14,
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.line,
    gap: 12,
    minWidth: 0,
  },
  callout: { gap: 10 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, minWidth: 0 },
  references: {
    gap: 6,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  reference: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 20,
    flexShrink: 1,
  },
});
