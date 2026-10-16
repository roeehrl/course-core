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
import { Badge, Button, ChoiceList, colors, Field, Notice, styles } from "./ui";

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
  if (!account) return <Notice>Sign in to view your learning memory.</Notice>;
  if (!enrollment)
    return <Notice>Choose an enrollment to view your learning memory.</Notice>;
  if (api.accountId !== account.id)
    return (
      <Notice error>
        Memory is unavailable while your account changes. Reopen it after
        signing in.
      </Notice>
    );
  const episodeId =
    props.episodeId ?? enrollment.course.chapters[0]?.episodes[0]?.id;
  if (
    !episodeId ||
    !enrollment.course.chapters.some((chapter) =>
      chapter.episodes.some((episode) => episode.id === episodeId),
    )
  ) {
    return (
      <Notice>
        This lesson is no longer available. Return to the course to choose
        another lesson.
      </Notice>
    );
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

const paceOptions = [
  { id: "gentle", label: "Gentle" },
  { id: "steady", label: "Steady" },
  { id: "focused", label: "Focused" },
];
const styleOptions = [
  { id: "concise", label: "Concise" },
  { id: "step_by_step", label: "Step by step" },
  { id: "worked_example", label: "Worked examples" },
];
const cleanProfile = (value: MemoryProfile): MemoryProfile => ({
  preferences: { ...value.preferences },
  priorKnowledge: value.priorKnowledge.map((row) => ({ ...row })),
  thoughts: value.thoughts,
});
function errorCopy(error: unknown) {
  if (!(error instanceof CourseApiError))
    return "Memory could not be updated. Your draft is still here. Try again when the connection is available.";
  switch (error.code) {
    case "STALE_REVISION":
      return "Your memory or progress changed elsewhere. Refresh the saved version, then review your draft before saving again.";
    case "PROPOSAL_SOURCE_CHANGED":
      return "The source for this suggestion changed. Refresh and review its references before deciding again.";
    case "PROPOSAL_NOT_FOUND":
      return "This suggestion is no longer available. Refresh to see the current suggestions.";
    case "UNAUTHENTICATED":
      return "Your session expired. Sign in again to view your memory.";
    case "FORBIDDEN":
      return "You no longer have access to this learning memory.";
    case "NETWORK_UNCERTAIN":
      return "The connection was interrupted. A submitted change may already be saved. Retry the same change to confirm it.";
    case "PENDING_UNCERTAIN":
      return "An earlier change is unconfirmed. Resolve that saved request before making another change.";
    case "INVALID_REQUEST":
      return "Check the form: each prior-knowledge claim needs text, and each objective can appear only once.";
    case "INVALID_RESPONSE":
      return "The saved memory could not be read safely. Refresh before making another change.";
    case "EVIDENCE_NOT_FOUND":
      return "That evidence is no longer available. Refresh to see your current evidence.";
    case "EVIDENCE_CONTROL_UNCHANGED":
      return "That result already has this setting, or its review was closed. Refresh to see its current state.";
    case "EVIDENCE_INVALIDATED":
      return "This result no longer counts, so there is nothing left to dispute.";
    case "EVIDENCE_DISPUTE_LIMIT":
      return "You have 20 open disputes. Wait for a review, or withdraw one, before raising another.";
    case "CSRF_REJECTED":
    case "ORIGIN_REJECTED":
      return "Your session could not authorize this change. Reopen the signed-in course and try again.";
    default:
      return "Memory is temporarily unavailable. Your draft is still here; no result has been assumed.";
  }
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
          ? errorCopy(caught)
          : "This enrollment is unavailable. It may have been removed, or your access may have changed.",
      );
    }
    setError(errorCopy(caught));
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
        setNotice("Change saved. Assessment evidence is unchanged.");
      else if (keepDraft)
        setNotice(
          "Saved version refreshed. Your draft is preserved; review it before saving.",
        );
    } catch (caught) {
      if (abort.signal.aborted || version !== generation.current) return;
      handleError(caught);
      setNeedsRefresh(true);
      if (afterSave)
        setNotice("Your change was saved. Refresh to see the latest memory.");
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
      setHistoryError(errorCopy(caught));
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
      setChangesError(errorCopy(caught));
      if (
        caught instanceof CourseApiError &&
        [401, 403, 404, 410].includes(caught.status)
      )
        handleError(caught);
    } finally {
      if (changesAbort.current === abort) setChangesLoading(false);
    }
  }
  function edit(next: MemoryProfile) {
    setDraft(next);
    setNotice("");
  }
  const save = () => {
    if (disabled || !draft || !snapshot) return;
    if (draft.priorKnowledge.some((row) => !row.statement.trim())) {
      setError(
        "Add a short statement to each prior-knowledge claim, or remove the empty claim.",
      );
      return;
    }
    void perform(() => api.save(scope, snapshot.revision, draft), false);
  };

  if (fatal)
    return (
      <View style={local.panel}>
        <Notice error>{fatal}</Notice>
        <Button
          label="Check access again"
          onPress={() => void refresh(false)}
          disabled={loading}
        />
      </View>
    );
  return (
    <View style={local.panel}>
      <View style={styles.spread}>
        <View style={local.grow}>
          <Text style={styles.eyebrow}>Your learning memory</Text>
          <Text accessibilityRole="header" style={styles.title}>
            A profile you can shape.
          </Text>
          <Text style={styles.body}>
            What you have shared, what your work demonstrates, and suggestions
            you can review.
          </Text>
        </View>
        <Badge label={account.displayName || "Your account"} tone="lilac" />
      </View>
      <Text style={styles.small}>
        Lesson: {lessonTitle}. Memory belongs to this enrollment.
      </Text>
      {loading && (
        <View style={styles.row}>
          <ActivityIndicator accessibilityLabel="Loading learning memory" />
          <Text accessibilityLiveRegion="polite" style={styles.small}>
            Loading saved memory…
          </Text>
        </View>
      )}
      {!!error && <Notice error>{error}</Notice>}
      {!!notice && <Notice>{notice}</Notice>}
      {uncertain && (
        <View style={local.callout}>
          <Notice>
            An earlier memory change is unconfirmed. Retry that exact change
            before editing further.
          </Notice>
          <Button
            label="Retry unconfirmed change"
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
            <Notice>
              Your progress changed. Refresh memory before making another
              change.
            </Notice>
          )}
          <Button
            label={draft ? "Refresh & keep draft" : "Retry loading memory"}
            disabled={busy || loading}
            onPress={() => void refresh(!!draft)}
          />
        </View>
      )}
      {snapshot && draft && (
        <>
          <Section
            eyebrow="Evidence from your work"
            title="What you have demonstrated"
          >
            <Text style={styles.body}>
              These results come from saved independent checks for this course.
              Preferences, prior-knowledge claims and AI suggestions cannot
              award credit.
            </Text>
            {snapshot.understanding.length === 0 && (
              <Text style={styles.body}>
                No objective results are available for this lesson.
              </Text>
            )}
            {snapshot.understanding.map((row) => (
              <View key={row.objectiveId} style={local.inset}>
                <Text accessibilityRole="header" style={styles.heading}>
                  {objectiveTitle(row.objectiveId)}
                </Text>
                <Badge
                  label={skillLabels[row.status]}
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
                    {row.independentFamilies}
                    {row.familiesTruncated ? "+" : ""} independent question
                    families recorded; {row.requiredFamilies} required.{" "}
                    {retentionCopy(row)}
                  </Text>
                ) : (
                  <Text style={styles.body}>
                    No assessment gate is defined for this objective.
                  </Text>
                )}
                {row.practiceAttempts > 0 && !row.demonstrated && (
                  <Text style={styles.small}>
                    {row.practiceAttempts} recorded{" "}
                    {row.practiceAttempts === 1 ? "answer" : "answers"} so far.
                    Practice shows you are working on it; it is not yet a
                    demonstration.
                  </Text>
                )}
                {row.openDisputes > 0 && (
                  <Text style={styles.small}>
                    A review you asked for is open. Until it is decided, this
                    objective is shown as disputed. Your credit is unchanged
                    while it is reviewed.
                  </Text>
                )}
                <Disclosure
                  label={`evidence references for ${objectiveTitle(row.objectiveId)}`}
                >
                  {row.evidenceRefs.length === 0 && (
                    <Text style={styles.small}>
                      No qualifying evidence references yet.
                    </Text>
                  )}
                  {row.evidenceRefs.map((ref) => (
                    <View key={ref.evidenceId} style={local.references}>
                      <Reference label="Evidence" value={ref.evidenceId} />
                      <Reference label="Attempt" value={ref.attemptId} />
                      <Reference
                        label="Course digest"
                        value={ref.courseDigest}
                      />
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
                        Only a bounded selection of references is shown. Search
                        your evidence history for more.
                      </Text>
                    )}
                </Disclosure>
              </View>
            ))}
            {snapshot.scope.objectivesTruncated && (
              <Notice>
                This snapshot shows a limited set of lesson objectives.
              </Notice>
            )}
          </Section>

          <View style={local.columns}>
            <View style={local.column}>
              <Section
                eyebrow="In your own words"
                title="Preferences & prior knowledge"
              >
                <Badge
                  label={dirty ? "Unsaved changes" : "Saved self-report"}
                  tone={dirty ? "sand" : "neutral"}
                />
                <Text style={styles.body}>
                  Tell us what helps you learn. These are your statements,
                  separate from assessment evidence. Your preferences take
                  priority over reviewed suggestions.
                </Text>
                <ChoiceList
                  label="Preferred learning pace"
                  options={[
                    { id: "", label: "No pace preference" },
                    ...paceOptions,
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
                  label="Preferred explanation style"
                  options={[
                    { id: "", label: "No explanation preference" },
                    ...styleOptions,
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
                  label="My learning goal"
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
                  This goal is part of your private memory. The learning goal
                  on your profile (the one you gave when you started) is
                  different: course staff who can see your enrollment can read
                  it, along with your name and pace.
                </Text>
                <Text accessibilityRole="header" style={styles.heading}>
                  What I already know
                </Text>
                <Text style={styles.small}>
                  A claim helps guide teaching. It does not prove mastery.
                </Text>
                {draft.priorKnowledge.length === 0 && (
                  <Text style={styles.small}>
                    No prior-knowledge claims in your current profile.
                  </Text>
                )}
                {draft.priorKnowledge.map((row) => (
                  <View key={row.objectiveId} style={local.inset}>
                    <Field
                      label={`My prior knowledge: ${objectiveTitle(row.objectiveId)}`}
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
                      label="Remove claim"
                      accessibilityLabel={`Remove claim for ${objectiveTitle(row.objectiveId)}`}
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
                        label={`Add claim: ${objectiveTitle(id)}`}
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
                  Removing a claim updates your current profile when you save.
                  Earlier edits remain in your change history.
                </Text>
                <Field
                  label="My thoughts about learning"
                  value={draft.thoughts}
                  multiline
                  maxLength={1000}
                  editable={!disabled}
                  onChangeText={(thoughts) => edit({ ...draft, thoughts })}
                />
                <Text style={styles.small}>
                  Thoughts are saved in your memory and are excluded from the
                  current AI context projection. Course staff cannot read
                  anything you save here, in the app or in a copy of your data
                  they download; only your own download under Your data
                  includes it.
                </Text>
                {compared && dirty && (
                  <Disclosure label="latest saved profile for comparison">
                    <ProfileSummary
                      value={snapshot.selfReport}
                      title={objectiveTitle}
                    />
                  </Disclosure>
                )}
                <View style={styles.row}>
                  <Button
                    label={busy ? "Saving change…" : "Save my profile"}
                    kind="primary"
                    disabled={disabled || !dirty}
                    onPress={save}
                  />
                  <Button
                    label="Discard draft"
                    kind="quiet"
                    disabled={disabled || !dirty}
                    onPress={() => {
                      setDraft(cleanProfile(snapshot.selfReport));
                      setCompared(false);
                      setError("");
                      setNotice(
                        "Draft discarded. Your saved profile is unchanged.",
                      );
                    }}
                  />
                </View>
              </Section>
            </View>
            <View style={local.column}>
              <Section eyebrow="For you to review" title="AI suggestions">
                <Text style={styles.body}>
                  Suggestions are proposals, not facts about you. Accept,
                  correct or dispute them. Reviewing one never changes your
                  grades or silently edits your preferences.
                </Text>
                {snapshot.suggestions.items.length === 0 && (
                  <View style={local.inset}>
                    <Text style={styles.heading}>Nothing to review.</Text>
                    <Text style={styles.body}>
                      No suggestions are recorded for this lesson.
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
                  <Notice>
                    This is a limited selection. Your change history retains
                    earlier proposals and reviews.
                  </Notice>
                )}
              </Section>
            </View>
          </View>

          <Section
            eyebrow="Find your earlier work"
            title="Questions & evidence history"
          >
            <Text style={styles.body}>
              Search your questions and submitted checks in {lessonTitle}.
              Answers and grading keys are excluded.
            </Text>
            <Field
              label="Search my history"
              value={query}
              maxLength={100}
              onChangeText={setQuery}
              placeholder="A word or phrase, or leave blank for recent history"
              returnKeyType="search"
              onSubmitEditing={() => void search()}
              editable={!historyLoading}
            />
            <View style={styles.row}>
              {(
                [
                  ["all", "All history"],
                  ["questions", "My questions"],
                  ["evidence", "Assessment evidence"],
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
              label={historyLoading ? "Searching history…" : "Search history"}
              onPress={() => void search()}
              disabled={historyLoading}
            />
            {!!historyError && <Notice error>{historyError}</Notice>}
            {history && (
              <View style={local.stack}>
                <Text accessibilityLiveRegion="polite" style={styles.small}>
                  {history.items.length} results in this window
                  {searched?.q ? ` for “${searched.q}”` : ""}. Each request
                  checks up to 200 events and returns at most 10 results.
                </Text>
                {history.items.length === 0 && (
                  <Notice>
                    {history.nextCursor
                      ? "No matches in this window. Earlier history is still available."
                      : "No matching history in this window."}
                  </Notice>
                )}
                {history.items.map((item) => (
                  <View key={item.eventId} style={local.inset}>
                    <Badge
                      label={
                        item.kind === "questions"
                          ? "Your question"
                          : `${item.passed ? "Passed" : "Not passed"} · ${item.mode}`
                      }
                      tone="neutral"
                    />
                    <Text selectable style={styles.body}>
                      {item.text || "No question text is available."}
                    </Text>
                    <Disclosure label={`history references ${item.cursor}`}>
                      <Reference label="Event" value={item.eventId} />
                      {item.kind === "questions" ? (
                        <Reference label="Message" value={item.messageId} />
                      ) : (
                        <>
                          <Reference label="Attempt" value={item.attemptId} />
                          {item.evidenceRefs.map((ref) => (
                            <View key={ref.evidenceId}>
                              <Reference
                                label="Evidence"
                                value={ref.evidenceId}
                              />
                              <Text style={styles.small}>
                                {ref.invalidated
                                  ? "Invalidated · does not count"
                                  : ref.independent
                                    ? "Independent evidence"
                                    : "Practice or assisted · not independent"}
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
                              Additional references are not shown.
                            </Text>
                          )}
                        </>
                      )}
                    </Disclosure>
                  </View>
                ))}
                <Text style={styles.small}>
                  Search covers the first 4,000 characters of each question;
                  matching excerpts are shortened. Earlier history loads one
                  window at a time.
                </Text>
                {history.nextCursor && (
                  <Button
                    label="Search earlier history"
                    disabled={historyLoading}
                    onPress={() => void search(history.nextCursor!)}
                  />
                )}
              </View>
            )}
          </Section>
          <Section
            eyebrow="A record you can inspect"
            title="Profile & review changes"
          >
            <Text style={styles.body}>
              Earlier versions and decisions stay in this enrollment’s history.
              A correction changes your current statement, not earned evidence.
            </Text>
            <Button
              label={
                changesLoading ? "Loading changes…" : "View latest changes"
              }
              onPress={() => void showChanges()}
              disabled={changesLoading}
            />
            {!!changesError && <Notice error>{changesError}</Notice>}
            {changes?.items.length === 0 && (
              <Notice>
                No profile edits or suggestion reviews have been recorded.
              </Notice>
            )}
            {changes?.items.map((change) => (
              <View key={change.id} style={local.inset}>
                <Text style={styles.heading}>
                  {changeLabels[change.action]}
                </Text>
                <Text style={styles.small}>
                  {new Date(change.createdAt).toLocaleString()} ·{" "}
                  {change.actorKind === "learner"
                    ? "Learner edit"
                    : "Service proposal"}
                </Text>
                {change.data.reason ? (
                  <Text selectable style={styles.body}>
                    {change.data.reason}
                  </Text>
                ) : null}
                <Disclosure label={`change details ${change.cursor}`}>
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
                      )}
                    </Text>
                  )}
                  <Reference label="Change" value={change.id} />
                  <Reference label="Event" value={change.eventId} />
                  {change.data.sourceEventRefs?.map((ref) => (
                    <View key={ref.eventId}>
                      <Reference label="Source event" value={ref.eventId} />
                      <Reference label="Source digest" value={ref.digest} />
                    </View>
                  ))}
                </Disclosure>
              </View>
            ))}
            {changes?.nextCursor && (
              <Button
                label="Earlier changes"
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

const skillLabels: Record<MemoryUnderstanding["status"], string> = {
  not_assessed: "Not assessed",
  needs_evidence: "More independent evidence needed",
  practicing: "Practicing",
  demonstrated: "Demonstrated",
  retained: "Retained",
  needs_review: "Needs review",
  disputed: "Disputed",
};
function retentionCopy(row: MemoryUnderstanding) {
  if (row.retention === "retained")
    return "A later check confirmed you kept it.";
  if (row.retention === "needs_review")
    return "A later check suggests reviewing it again.";
  if (row.retention === "scheduled")
    return row.retentionDueAt
      ? `A later check is scheduled for ${new Date(row.retentionDueAt).toLocaleDateString()}.`
      : "A later check is scheduled.";
  return "Retention has not been checked yet.";
}
const changeLabels: Record<string, string> = {
  "profile.edited": "Profile edited",
  "proposal.created": "Suggestion proposed",
  "proposal.accepted": "Suggestion accepted",
  "proposal.corrected": "Suggestion corrected",
  "proposal.disputed": "Suggestion disputed",
  "proposal.source_revoked": "Suggestion revoked (its source was deleted)",
};
function suggestionLabel(
  value: MemorySuggestion,
  title: (id: string) => string,
) {
  if (value.kind === "pace")
    return `Suggested pace: ${paceOptions.find((row) => row.id === value.value)?.label ?? value.value}`;
  if (value.kind === "explanation_style")
    return `Suggested explanation: ${styleOptions.find((row) => row.id === value.value)?.label ?? value.value}`;
  return `Suggested review: ${title(value.objectiveId)}`;
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
      ? paceOptions
      : correction.kind === "explanation_style"
        ? styleOptions
        : objectives.map((row) => ({ id: row.id, label: row.description }));
  const status = {
    pending: "Awaiting your review",
    accepted: "Accepted suggestion",
    corrected: "Corrected by you",
    disputed: "Disputed · excluded from AI context",
    source_revoked: "Revoked · you deleted the question it was based on",
  }[proposal.status];
  return (
    <View style={local.inset}>
      <Badge
        label={status}
        tone={proposal.status === "pending" ? "lilac" : "neutral"}
      />
      <Text accessibilityRole="header" style={styles.heading}>
        {suggestionLabel(proposal.suggestion, objectiveTitle)}
      </Text>
      <Text style={styles.small}>
        {proposal.origin?.kind === "connected_agent"
          ? `From your connected agent ${proposal.origin.label ?? ""}`.trim()
          : "From this course's AI"}
      </Text>
      <Disclosure
        label={`source references for suggestion ${proposal.proposalId}`}
      >
        <Reference label="Proposal" value={proposal.proposalId} />
        <Text style={styles.small}>
          Original:{" "}
          {suggestionLabel(proposal.originalSuggestion, objectiveTitle)}
        </Text>
        {proposal.sourceEventRefs.map((ref) => (
          <View key={ref.eventId} style={local.references}>
            <Reference label="Source event" value={ref.eventId} />
            <Reference label="Event type" value={ref.eventType} />
            <Reference label="Recorded digest" value={ref.digest} />
          </View>
        ))}
        {proposal.decisionId && (
          <Reference label="Latest decision" value={proposal.decisionId} />
        )}
      </Disclosure>
      {proposal.status === "source_revoked" ? (
        <Text style={styles.small}>
          You deleted the question this suggestion was based on, so it is no
          longer used and cannot be accepted again.
        </Text>
      ) : (
      <View
        ref={actionsRef}
        tabIndex={-1}
        accessibilityRole="toolbar"
        accessibilityLabel="Suggestion review actions"
        style={styles.row}
      >
        {proposal.status === "pending" || proposal.status === "disputed" ? (
          <Button
            label="Accept suggestion"
            disabled={locked || !!editing}
            onPress={() => void decide({ action: "accept" })}
          />
        ) : null}
        <Button
          label="Correct suggestion"
          disabled={locked || !!editing}
          onPress={() => {
            setCorrection(proposal.suggestion);
            setEditingRevision(proposal.decisionId);
            setEditing("correct");
          }}
        />
        {proposal.status !== "disputed" && (
          <Button
            label="Dispute suggestion"
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
            <Notice>
              The saved review changed. Your correction and note are still here;
              compare them with the current suggestion before saving.
            </Notice>
          )}
          <Text style={styles.body}>
            {editing === "correct"
              ? "Choose the version that represents you."
              : "Disputing excludes this suggestion from AI context and preserves the review history."}
          </Text>
          {editing === "correct" && (
            <ChoiceList
              label="Corrected suggestion"
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
            label="Review note (optional)"
            multiline
            maxLength={500}
            value={reason}
            editable={!locked}
            onChangeText={setReason}
          />
          <View style={styles.row}>
            <Button
              label={
                editing === "correct" ? "Save correction" : "Confirm dispute"
              }
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
              label="Cancel review"
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
  const short = evidenceId.slice(0, 8);
  return (
    <View style={local.stack}>
      <Text style={styles.small}>
        {disputed
          ? "Disputed · a review is open. "
          : ""}
        {excluded
          ? "Not used by your companion or supervisor."
          : "Your companion and supervisor may use this result."}
      </Text>
      {writing ? (
        <View style={local.stack}>
          <Field
            label={`Why should evidence ${short} be reviewed?`}
            multiline
            value={reason}
            onChangeText={setReason}
            maxLength={500}
            placeholder="For example: my answer was marked wrong but I believe it is correct."
          />
          <Text style={styles.small}>
            Staff see that this result is disputed and review it. Your
            explanation stays with you. Disputing never changes credit by
            itself.
          </Text>
          <View style={local.actions}>
            <Button
              label="Send dispute"
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
              label="Cancel"
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
              label={`Withdraw dispute ${short}`}
              disabled={disabled}
              onPress={() => void onControl(evidenceId, "withdraw_dispute")}
            />
          ) : (
            !invalidated && (
              <Button
                label={`Dispute result ${short}`}
                disabled={disabled}
                onPress={() => setWriting(true)}
              />
            )
          )}
          <Button
            label={
              excluded
                ? `Use ${short} in AI context again`
                : `Exclude ${short} from AI context`
            }
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
  return (
    <View style={local.stack}>
      <Text selectable style={styles.body}>
        Goal: {value.preferences.goal || "No goal saved."}
      </Text>
      <Text style={styles.small}>
        Pace: {value.preferences.pace ?? "No preference"}. Explanation:{" "}
        {styleOptions.find(
          (row) => row.id === value.preferences.explanationStyle,
        )?.label ?? "No preference"}
        .
      </Text>
      {value.priorKnowledge.map((row) => (
        <Text key={row.objectiveId} selectable style={styles.body}>
          {title(row.objectiveId)}: {row.statement}
        </Text>
      ))}
      <Text selectable style={styles.body}>
        Thoughts: {value.thoughts || "None saved."}
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
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={local.stack}>
      <Button
        label={`${open ? "Hide" : "Show"} ${label}`}
        selected={open}
        kind="quiet"
        onPress={() => setOpen((value) => !value)}
      />
      {open && children}
    </View>
  );
}
function Reference({ label, value }: { label: string; value: string }) {
  return (
    <Text selectable style={local.reference}>
      {label}: {value}
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
