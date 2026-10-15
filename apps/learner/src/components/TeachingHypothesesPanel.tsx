import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { CourseApiError, type ServerSnapshot } from "../client/apiClient";
import type {
  HypothesisClient,
  HypothesisDecision,
  HypothesisSnapshot,
  ProbeResult,
  ProbeRun,
  TeachingHypothesis,
} from "../client/hypothesisClient";
import { Badge, Button, ChoiceList, colors, Field, Notice, styles } from "./ui";

export interface TeachingHypothesesPanelProps {
  enrollment: Pick<ServerSnapshot, "enrollmentId" | "revision" | "course">;
  client: HypothesisClient;
  /** Objectives offered for "ask for a check"; defaults to all course objectives. */
  episodeId?: string;
  onRevision?: (revision: number) => void;
}

const kindLabel: Record<TeachingHypothesis["kind"], string> = {
  misconception: "Possible mix-up",
  missing_prerequisite: "Possibly missing background",
  slip: "Possible slip",
  ambiguous_item: "Possibly unclear question",
  useful_analogy: "Comparison that may help",
};
const sourceLabel: Record<TeachingHypothesis["source"], string> = {
  assessment: "Noticed from a check answer",
  supervisor: "Suggested by your AI tutor",
  companion: "Noticed from your questions",
  learner: "From your request",
};
const certaintyLabel: Record<TeachingHypothesis["uncertainty"], string> = {
  high: "Tentative",
  medium: "Some support",
  low: "Well supported",
};
function statusLabel(h: TeachingHypothesis) {
  if (h.status === "rejected")
    return h.rejectedBy === "learner"
      ? "You rejected this"
      : h.rejectedBy === "evidence"
        ? "Ruled out by a quick check"
        : "Set aside by your tutor";
  return {
    proposed: "An idea to check",
    probing: "Being checked",
    confirmed: "Supported by your answers",
    resolved: "Resolved by your later work",
    expired: "Expired",
    rejected: "Rejected",
  }[h.status];
}
const active = (h: TeachingHypothesis) =>
  ["proposed", "probing", "confirmed"].includes(h.status);
function errorCopy(error: unknown) {
  if (!(error instanceof CourseApiError))
    return "This could not be saved. Nothing about your progress changed. Try again.";
  switch (error.code) {
    case "HYPOTHESIS_CHANGED":
    case "STALE_REVISION":
      return "This changed since you opened it. The latest version is shown; review it and try again.";
    case "DIAGNOSTIC_REQUEST_LIMIT":
      return "You have asked for the most checks allowed today. Try again tomorrow.";
    case "PROBE_EXPIRED":
      return "This check expired. You can ask for a new one.";
    case "PROBE_ALREADY_ANSWERED":
      return "This check was already answered.";
    case "NETWORK_UNCERTAIN":
      return "The connection was interrupted. Your change may already be saved. Retry the same change to confirm it.";
    case "PENDING_UNCERTAIN":
      return "An earlier change is unconfirmed. Retry it before making another change.";
    case "INVALID_ANSWER":
      return "Choose an answer, or select “I don’t know”.";
    default:
      return "This is temporarily unavailable. Nothing about your progress changed.";
  }
}

/** The learner's teaching hypotheses in plain language, with correct, reject,
 * pin and "ask for a check" controls, and any quick diagnostic checks. */
export function TeachingHypothesesPanel({
  enrollment,
  client,
  episodeId,
  onRevision,
}: TeachingHypothesesPanelProps) {
  const [snapshot, setSnapshot] = useState<HypothesisSnapshot>();
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [result, setResult] = useState<ProbeResult>();
  const generation = useRef(0);
  const objectiveTitle = (id: string) =>
    enrollment.course.objectives.find((o) => o.id === id)?.description ?? id;
  const objectives = (() => {
    const episode = enrollment.course.chapters
      .flatMap((c) => c.episodes)
      .find((e) => e.id === episodeId);
    const ids = (episode as { objectiveIds?: string[] } | undefined)
      ?.objectiveIds;
    return enrollment.course.objectives.filter(
      (o) => !ids || ids.includes(o.id),
    );
  })();

  async function load() {
    const version = ++generation.current;
    setLoading(true);
    try {
      const next = await client.load(enrollment.enrollmentId);
      if (version === generation.current) setSnapshot(next);
    } catch (caught) {
      if (version === generation.current) setError(errorCopy(caught));
    } finally {
      if (version === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, [client, enrollment.enrollmentId, enrollment.revision]);

  async function perform<T extends { revision: number }>(
    operation: () => Promise<T>,
    done: (value: T) => string,
  ) {
    if (busy) return false;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const value = await operation();
      setNotice(done(value));
      onRevision?.(value.revision);
      await load();
      return true;
    } catch (caught) {
      setError(errorCopy(caught));
      if (
        caught instanceof CourseApiError &&
        ["HYPOTHESIS_CHANGED", "STALE_REVISION"].includes(caught.code)
      )
        await load();
      return false;
    } finally {
      setBusy(false);
    }
  }
  const decide = (h: TeachingHypothesis, decision: HypothesisDecision) =>
    perform(
      () => client.decide(snapshot!, h, decision),
      () =>
        ({
          pin: "Pinned. Your tutor will keep this in mind until you unpin it.",
          unpin: "Unpinned.",
          reject:
            "Rejected. It is no longer used to guide your teaching, and it will not be suggested again.",
          correct:
            "Your correction is saved and replaces the original wording for your tutor.",
        })[decision.action],
    );

  const items = snapshot?.items ?? [];
  const current = items.filter(active),
    past = items.filter((h) => !active(h));
  const openProbes = (snapshot?.probes ?? []).filter(
    (p) => p.state === "scheduled" && p.question,
  );
  return (
    <View style={[styles.card, local.panel]}>
      <Text style={styles.eyebrow}>How we are teaching you</Text>
      <Text accessibilityRole="header" style={styles.heading}>
        Ideas about what may help you
      </Text>
      <Text style={styles.body}>
        When an answer or question suggests a specific mix-up, your course
        records it here as an idea to check, never as a grade. You can correct
        it, reject it, pin it so it is kept in mind, or ask for a quick check.
        None of this changes your progress.
      </Text>
      {loading && !snapshot && (
        <View style={styles.row}>
          <ActivityIndicator accessibilityLabel="Loading teaching ideas" />
        </View>
      )}
      {!!error && <Notice error>{error}</Notice>}
      {!!notice && <Notice>{notice}</Notice>}
      {snapshot && client.pending(enrollment.enrollmentId) && (
        <Button
          label="Retry unconfirmed change"
          disabled={busy}
          onPress={() =>
            void perform(
              () => client.retry(enrollment.enrollmentId),
              () => "Your change is confirmed.",
            )
          }
        />
      )}
      {openProbes.map((probe) => (
        <ProbeCard
          key={probe.probeRunId}
          probe={probe}
          disabled={busy}
          onAnswer={(answer) =>
            perform(
              () => client.answerProbe(snapshot!, probe.probeRunId, answer),
              (value) => {
                setResult(value as ProbeResult);
                return "Thanks. This check helps your tutor; it does not count toward your progress.";
              },
            )
          }
        />
      ))}
      {result && (
        <View style={local.inset} accessibilityLiveRegion="polite">
          <Text style={styles.heading}>Quick check result</Text>
          <Text style={styles.body}>
            {result.outcome === "abstained"
              ? "You chose “I don’t know”. That is useful too; nothing was marked wrong."
              : result.correct
                ? "Correct."
                : "Not quite."}{" "}
            {result.explanation ?? ""}
          </Text>
          <Text style={styles.small}>
            {result.conclusive
              ? "Your answer helped tell the ideas apart. They are updated below."
              : "Your answer did not settle which idea fits, so nothing was changed."}
          </Text>
        </View>
      )}
      {snapshot && current.length === 0 && (
        <View style={local.inset}>
          <Text style={styles.heading}>No open ideas.</Text>
          <Text style={styles.body}>
            Nothing specific has been noticed. You can still ask for a quick
            check below.
          </Text>
        </View>
      )}
      {current.map((h) => (
        <HypothesisCard
          key={h.hypothesisId}
          hypothesis={h}
          disabled={busy || !snapshot}
          objectiveTitle={objectiveTitle}
          onDecide={(decision) => decide(h, decision)}
          onRequestCheck={() =>
            perform(
              () =>
                client.requestDiagnostic(snapshot!, {
                  hypothesisId: h.hypothesisId,
                }),
              (value) =>
                value.state === "probe_scheduled"
                  ? "A quick check is ready above."
                  : "Your tutor will prepare a check for this.",
            )
          }
        />
      ))}
      {snapshot && (
        <AskForCheck
          objectives={objectives}
          disabled={busy}
          onRequest={(objectiveId, note) =>
            perform(
              () =>
                client.requestDiagnostic(snapshot, {
                  objectiveId,
                  ...(note ? { note } : {}),
                }),
              (value) =>
                value.state === "probe_scheduled"
                  ? "A quick check is ready above."
                  : "Your request is saved. Your tutor will prepare a check.",
            )
          }
        />
      )}
      {past.length > 0 && (
        <Disclosure label="earlier ideas">
          {past.map((h) => (
            <View key={h.hypothesisId} style={local.inset}>
              <Badge label={statusLabel(h)} tone="neutral" />
              <Text style={styles.body}>
                {h.learnerCorrection ?? h.statement}
              </Text>
            </View>
          ))}
        </Disclosure>
      )}
    </View>
  );
}

function HypothesisCard({
  hypothesis: h,
  disabled,
  objectiveTitle,
  onDecide,
  onRequestCheck,
}: {
  hypothesis: TeachingHypothesis;
  disabled: boolean;
  objectiveTitle: (id: string) => string;
  onDecide: (decision: HypothesisDecision) => Promise<boolean>;
  onRequestCheck: () => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<"correct" | "reject">();
  const [correction, setCorrection] = useState(
    h.learnerCorrection ?? h.statement,
  );
  const [reason, setReason] = useState("");
  const close = () => {
    setEditing(undefined);
    setReason("");
  };
  return (
    <View
      style={local.inset}
      accessibilityLabel={`Teaching idea: ${h.learnerCorrection ?? h.statement}`}
    >
      <View style={styles.row}>
        <Badge label={kindLabel[h.kind]} tone="lilac" />
        <Badge label={statusLabel(h)} tone="neutral" />
        {h.pinned && <Badge label="Pinned by you" tone="sand" />}
      </View>
      <Text selectable style={styles.heading}>
        {h.learnerCorrection ?? h.statement}
      </Text>
      {h.learnerCorrection && (
        <Text style={styles.small}>
          Your correction. Original wording: {h.statement}
        </Text>
      )}
      <Text style={styles.small}>
        {sourceLabel[h.source]} · {certaintyLabel[h.uncertainty]} · based on{" "}
        {h.observations} {h.observations === 1 ? "observation" : "observations"}{" "}
        · {h.objectiveIds.map(objectiveTitle).join(", ")}
      </Text>
      <Disclosure label={`evidence for this idea`}>
        {h.evidenceRefs.length === 0 && (
          <Text style={styles.small}>No linked answers yet.</Text>
        )}
        {h.evidenceRefs.map((ref) => (
          <Text key={`${ref.kind}:${ref.id}`} selectable style={local.reference}>
            {ref.kind === "attempt"
              ? "Check answer"
              : ref.kind === "probe_run"
                ? "Quick check"
                : "Learning event"}{" "}
            {ref.supports ? "supporting" : "against"} ·{" "}
            {new Date(ref.at).toLocaleString()} · {ref.id}
          </Text>
        ))}
      </Disclosure>
      <View
        accessibilityRole="toolbar"
        accessibilityLabel="Teaching idea actions"
        style={styles.row}
      >
        <Button
          label={h.pinned ? "Unpin" : "Pin"}
          accessibilityLabel={`${h.pinned ? "Unpin" : "Pin"} idea`}
          disabled={disabled || !!editing}
          onPress={() => void onDecide({ action: h.pinned ? "unpin" : "pin" })}
        />
        <Button
          label="Correct"
          accessibilityLabel="Correct this idea"
          disabled={disabled || !!editing}
          onPress={() => setEditing("correct")}
        />
        <Button
          label="Reject"
          accessibilityLabel="Reject this idea"
          kind="quiet"
          disabled={disabled || !!editing}
          onPress={() => setEditing("reject")}
        />
        <Button
          label="Check this"
          accessibilityLabel="Ask for a quick check of this idea"
          kind="quiet"
          disabled={disabled || !!editing}
          onPress={() => void onRequestCheck()}
        />
      </View>
      {editing && (
        <View style={local.stack}>
          {editing === "correct" ? (
            <Field
              label="Say it in your own words"
              multiline
              maxLength={500}
              value={correction}
              editable={!disabled}
              onChangeText={setCorrection}
            />
          ) : (
            <Text style={styles.body}>
              Rejecting stops this idea guiding your teaching. It stays in your
              history.
            </Text>
          )}
          <Field
            label="Note (optional)"
            multiline
            maxLength={500}
            value={reason}
            editable={!disabled}
            onChangeText={setReason}
          />
          <View style={styles.row}>
            <Button
              label={editing === "correct" ? "Save correction" : "Confirm reject"}
              kind="primary"
              disabled={
                disabled || (editing === "correct" && !correction.trim())
              }
              onPress={async () => {
                const reasonText = reason.trim();
                const ok = await onDecide(
                  editing === "correct"
                    ? {
                        action: "correct",
                        correction: correction.trim(),
                        ...(reasonText ? { reason: reasonText } : {}),
                      }
                    : {
                        action: "reject",
                        ...(reasonText ? { reason: reasonText } : {}),
                      },
                );
                if (ok) close();
              }}
            />
            <Button label="Cancel" kind="quiet" disabled={disabled} onPress={close} />
          </View>
        </View>
      )}
    </View>
  );
}

function ProbeCard({
  probe,
  disabled,
  onAnswer,
}: {
  probe: ProbeRun;
  disabled: boolean;
  onAnswer: (
    answer: { answer: string | number } | { abstain: true },
  ) => Promise<boolean>;
}) {
  const [value, setValue] = useState("");
  const question = probe.question!;
  const answer =
    question.type === "choice"
      ? value
      : value.trim() !== "" && Number.isFinite(Number(value))
        ? Number(value)
        : null;
  return (
    <View style={[local.inset, local.probe]}>
      <Badge label="Quick check · does not count toward progress" tone="sand" />
      <Text accessibilityRole="header" style={styles.heading}>
        {question.prompt}
      </Text>
      {question.type === "choice" ? (
        <ChoiceList
          label="Quick check answer"
          options={question.options.map((o) => ({ id: o.id, label: o.text }))}
          value={value}
          disabled={disabled}
          onChange={setValue}
        />
      ) : (
        <Field
          label={`Quick check answer${question.unit ? ` (${question.unit})` : ""}`}
          keyboardType="numeric"
          value={value}
          editable={!disabled}
          onChangeText={setValue}
        />
      )}
      <View style={styles.row}>
        <Button
          label="Submit check"
          kind="primary"
          disabled={disabled || answer === null || answer === ""}
          onPress={() => void onAnswer({ answer: answer! })}
        />
        <Button
          label="I don’t know"
          kind="quiet"
          disabled={disabled}
          onPress={() => void onAnswer({ abstain: true })}
        />
      </View>
    </View>
  );
}

function AskForCheck({
  objectives,
  disabled,
  onRequest,
}: {
  objectives: readonly { id: string; description: string }[];
  disabled: boolean;
  onRequest: (objectiveId: string, note: string) => Promise<boolean>;
}) {
  const [objectiveId, setObjectiveId] = useState(objectives[0]?.id ?? "");
  const [note, setNote] = useState("");
  if (!objectives.length) return null;
  return (
    <Disclosure label="ask for a quick check">
      <View style={local.stack}>
        <ChoiceList
          label="What should the check cover?"
          options={objectives.map((o) => ({ id: o.id, label: o.description }))}
          value={objectiveId}
          disabled={disabled}
          onChange={setObjectiveId}
        />
        <Field
          label="What do you think is confusing you? (optional)"
          multiline
          maxLength={500}
          value={note}
          editable={!disabled}
          onChangeText={setNote}
        />
        <Button
          label="Ask for a check"
          kind="primary"
          disabled={disabled || !objectiveId}
          onPress={async () => {
            if (await onRequest(objectiveId, note.trim())) setNote("");
          }}
        />
      </View>
    </Disclosure>
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
        onPress={() => setOpen((v) => !v)}
      />
      {open && children}
    </View>
  );
}

const local = StyleSheet.create({
  panel: {
    width: "100%",
    maxWidth: 1120,
    alignSelf: "center",
    minWidth: 0,
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
  probe: { borderColor: colors.gold },
  reference: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 20,
    flexShrink: 1,
  },
});
