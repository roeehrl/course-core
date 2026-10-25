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
import { Badge, Button, ChoiceList, colors, Field, Notice, Eyebrow, styles } from "./ui";
import { useReservedHeight } from "./reservedHeight";
import {
  englishTranslator,
  useI18n,
  type MessageKey,
  type Translate,
} from "../i18n";

export interface TeachingHypothesesPanelProps {
  enrollment: Pick<ServerSnapshot, "enrollmentId" | "revision" | "course">;
  client: HypothesisClient;
  /** Objectives offered for "ask for a check"; defaults to all course objectives. */
  episodeId?: string;
  onRevision?: (revision: number) => void;
}

function statusLabel(h: TeachingHypothesis, t: Translate) {
  if (h.status === "rejected")
    return t(
      h.rejectedBy === "learner"
        ? "teachingHypothesesPanel.status.rejectedByLearner"
        : h.rejectedBy === "evidence"
          ? "teachingHypothesesPanel.status.rejectedByEvidence"
          : "teachingHypothesesPanel.status.rejectedByTutor",
    );
  return t(`teachingHypothesesPanel.status.${h.status}` as MessageKey);
}
const active = (h: TeachingHypothesis) =>
  ["proposed", "probing", "confirmed"].includes(h.status);
/** An unpinned idea still to be checked is kept for a limited time. */
const expiring = (h: TeachingHypothesis) =>
  h.status === "proposed" && !h.pinned && !!h.expiresAt;
function day(value: string | null, date: (value: number) => string) {
  const at = Date.parse(value ?? "");
  return Number.isFinite(at) ? date(at) : "";
}
const ERROR_CODES = new Set([
  "HYPOTHESIS_CHANGED",
  "STALE_REVISION",
  "DIAGNOSTIC_REQUEST_LIMIT",
  "HYPOTHESIS_LIMIT",
  "HYPOTHESIS_NOT_EXPIRING",
  "PROBE_EXPIRED",
  "PROBE_ALREADY_ANSWERED",
  "NETWORK_UNCERTAIN",
  "PENDING_UNCERTAIN",
  "INVALID_ANSWER",
]);
function errorCopy(error: unknown, t: Translate = englishTranslator().t) {
  if (!(error instanceof CourseApiError))
    return t("teachingHypothesesPanel.error.notSaved");
  return ERROR_CODES.has(error.code)
    ? t(`teachingHypothesesPanel.error.${error.code}` as MessageKey)
    : t("teachingHypothesesPanel.error.unavailable");
}

/** The learner's teaching hypotheses in plain language, with correct, reject,
 * pin and "ask for a check" controls, and any quick diagnostic checks. */
export function TeachingHypothesesPanel({
  enrollment,
  client,
  episodeId,
  onRevision,
}: TeachingHypothesesPanelProps) {
  const i18n = useI18n();
  const t = i18n.t;
  const date = (value: number) => i18n.date(value, "medium");
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
      if (version === generation.current) setError(errorCopy(caught, t));
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
      setError(errorCopy(caught, t));
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
  const lifetime = snapshot?.limits.ideaLifetimeDays ?? 30;
  const decide = (h: TeachingHypothesis, decision: HypothesisDecision) =>
    perform(
      () => client.decide(snapshot!, h, decision),
      () =>
        t(`teachingHypothesesPanel.done.${decision.action}` as MessageKey, {
          days: lifetime,
        }),
    );

  const reserve = useReservedHeight(
    `ideas:${enrollment.enrollmentId}`,
    !loading || !!snapshot,
  );
  const items = snapshot?.items ?? [];
  const current = items.filter(active),
    past = items.filter((h) => !active(h));
  const openProbes = (snapshot?.probes ?? []).filter(
    (p) => p.state === "scheduled" && p.question,
  );
  return (
    <View
      style={[styles.card, local.panel, { minHeight: reserve.minHeight }]}
      onLayout={reserve.onLayout}
    >
      <Eyebrow>{t("teachingHypothesesPanel.eyebrow")}</Eyebrow>
      <Text accessibilityRole="header" style={styles.heading}>
        {t("teachingHypothesesPanel.title")}
      </Text>
      <Text style={styles.body}>{t("teachingHypothesesPanel.intro")}</Text>
      {loading && !snapshot && (
        <View style={styles.row}>
          <ActivityIndicator
            accessibilityLabel={t("teachingHypothesesPanel.loading")}
          />
        </View>
      )}
      {snapshot?.automaticIdeas === false && (
        <Text style={styles.small}>
          {t("teachingHypothesesPanel.automaticOff")}
        </Text>
      )}
      {!!error && <Notice error>{error}</Notice>}
      {!!notice && <Notice>{notice}</Notice>}
      {snapshot && client.pending(enrollment.enrollmentId) && (
        <Button
          label={t("teachingHypothesesPanel.retry")}
          disabled={busy}
          onPress={() =>
            void perform(
              () => client.retry(enrollment.enrollmentId),
              () => t("teachingHypothesesPanel.done.retry"),
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
                return t("teachingHypothesesPanel.done.probe");
              },
            )
          }
        />
      ))}
      {result && (
        <View style={local.inset} accessibilityLiveRegion="polite">
          <Text style={styles.heading}>
            {t("teachingHypothesesPanel.result.title")}
          </Text>
          <Text style={styles.body}>
            {t(
              result.outcome === "abstained"
                ? "teachingHypothesesPanel.result.abstained"
                : result.correct
                  ? "teachingHypothesesPanel.result.correct"
                  : "teachingHypothesesPanel.result.incorrect",
            )}
{" "}
            {result.explanation ?? ""}
          </Text>
          <Text style={styles.small}>
            {t(
              result.conclusive
                ? "teachingHypothesesPanel.result.conclusive"
                : "teachingHypothesesPanel.result.inconclusive",
            )}
          </Text>
        </View>
      )}
      {snapshot && (
        <Text style={styles.small}>
          {t("teachingHypothesesPanel.lifetime", { days: lifetime })}
        </Text>
      )}
      {snapshot && current.length === 0 && (
        <View style={local.inset}>
          <Text style={styles.heading}>
            {t("teachingHypothesesPanel.empty.title")}
          </Text>
          <Text style={styles.body}>
            {t("teachingHypothesesPanel.empty.body")}
          </Text>
        </View>
      )}
      {current.map((h) => (
        <HypothesisCard
          key={h.hypothesisId}
          hypothesis={h}
          disabled={busy || !snapshot}
          lifetime={lifetime}
          date={date}
          objectiveTitle={objectiveTitle}
          onDecide={(decision) => decide(h, decision)}
          onRequestCheck={() =>
            perform(
              () =>
                client.requestDiagnostic(snapshot!, {
                  hypothesisId: h.hypothesisId,
                }),
              (value) =>
                t(
                  value.state === "probe_scheduled"
                    ? "teachingHypothesesPanel.done.probeReady"
                    : "teachingHypothesesPanel.done.checkRequested",
                ),
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
                t(
                  value.state === "probe_scheduled"
                    ? "teachingHypothesesPanel.done.probeReady"
                    : "teachingHypothesesPanel.done.requestSaved",
                ),
            )
          }
        />
      )}
      {past.length > 0 && (
        <Disclosure
          show={t("teachingHypothesesPanel.earlier.show")}
          hide={t("teachingHypothesesPanel.earlier.hide")}
        >
          {past.map((h) => (
            <View key={h.hypothesisId} style={local.inset}>
              <Badge label={statusLabel(h, t)} tone="neutral" />
              <Text style={styles.body}>
                {h.learnerCorrection ?? h.statement}
              </Text>
              {h.status === "expired" && (
                <>
                  {!!day(h.expiresAt, date) && (
                    <Text style={styles.small}>
                      {t("teachingHypothesesPanel.lapsedOn", {
                        date: day(h.expiresAt, date),
                      })}
                    </Text>
                  )}
                  <Button
                    label={t("teachingHypothesesPanel.bringBack")}
                    accessibilityLabel={t(
                      "teachingHypothesesPanel.bringBackLabel",
                      { days: lifetime },
                    )}
                    disabled={busy}
                    onPress={() => void decide(h, { action: "renew" })}
                  />
                </>
              )}
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
  lifetime,
  date,
  objectiveTitle,
  onDecide,
  onRequestCheck,
}: {
  hypothesis: TeachingHypothesis;
  disabled: boolean;
  lifetime: number;
  date: (value: number) => string;
  objectiveTitle: (id: string) => string;
  onDecide: (decision: HypothesisDecision) => Promise<boolean>;
  onRequestCheck: () => Promise<boolean>;
}) {
  const i18n = useI18n();
  const t = i18n.t;
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
      accessibilityLabel={t("teachingHypothesesPanel.card.label", {
        idea: h.learnerCorrection ?? h.statement,
      })}
    >
      <View style={styles.row}>
        <Badge
          label={t(`teachingHypothesesPanel.kind.${h.kind}` as MessageKey)}
          tone="lilac"
        />
        <Badge label={statusLabel(h, t)} tone="neutral" />
        {h.pinned && (
          <Badge label={t("teachingHypothesesPanel.card.pinned")} tone="sand" />
        )}
      </View>
      <Text selectable style={styles.heading}>
        {h.learnerCorrection ?? h.statement}
      </Text>
      {h.learnerCorrection && (
        <Text style={styles.small}>
          {t("teachingHypothesesPanel.card.original", {
            statement: h.statement,
          })}
        </Text>
      )}
      <Text style={styles.small}>
        {t("teachingHypothesesPanel.card.meta", {
          source: t(`teachingHypothesesPanel.source.${h.source}` as MessageKey),
          certainty: t(
            `teachingHypothesesPanel.certainty.${h.uncertainty}` as MessageKey,
          ),
          count: h.observations,
          objectives: h.objectiveIds.map(objectiveTitle).join(", "),
        })}
      </Text>
      {h.pinned ? (
        <Text style={styles.small}>
          {t("teachingHypothesesPanel.card.keptPinned")}
        </Text>
      ) : expiring(h) && day(h.expiresAt, date) ? (
        <Text style={styles.small}>
          {t("teachingHypothesesPanel.card.keptUntil", {
            date: day(h.expiresAt, date),
          })}
        </Text>
      ) : null}
      <Disclosure
        show={t("teachingHypothesesPanel.evidence.show")}
        hide={t("teachingHypothesesPanel.evidence.hide")}
      >
        {h.evidenceRefs.length === 0 && (
          <Text style={styles.small}>
            {t("teachingHypothesesPanel.evidence.empty")}
          </Text>
        )}
        {h.evidenceRefs.map((ref) => (
          <Text key={`${ref.kind}:${ref.id}`} selectable style={local.reference}>
            {t("teachingHypothesesPanel.evidence.reference", {
              kind: ref.kind,
              supports: ref.supports ? "yes" : "no",
              at: i18n.dateTime(ref.at),
              id: ref.id,
            })}
          </Text>
        ))}
      </Disclosure>
      <View
        accessibilityRole="toolbar"
        accessibilityLabel={t("teachingHypothesesPanel.actions")}
        style={styles.row}
      >
        <Button
          label={t(
            h.pinned
              ? "teachingHypothesesPanel.unpin"
              : "teachingHypothesesPanel.pin",
          )}
          accessibilityLabel={t(
            h.pinned
              ? "teachingHypothesesPanel.unpinLabel"
              : "teachingHypothesesPanel.pinLabel",
          )}
          disabled={disabled || !!editing}
          onPress={() => void onDecide({ action: h.pinned ? "unpin" : "pin" })}
        />
        {expiring(h) && (
          <Button
            label={t("teachingHypothesesPanel.renew")}
            accessibilityLabel={t("teachingHypothesesPanel.renewLabel", {
              days: lifetime,
            })}
            disabled={disabled || !!editing}
            onPress={() => void onDecide({ action: "renew" })}
          />
        )}
        <Button
          label={t("teachingHypothesesPanel.correct")}
          accessibilityLabel={t("teachingHypothesesPanel.correctLabel")}
          disabled={disabled || !!editing}
          onPress={() => setEditing("correct")}
        />
        <Button
          label={t("teachingHypothesesPanel.reject")}
          accessibilityLabel={t("teachingHypothesesPanel.rejectLabel")}
          kind="quiet"
          disabled={disabled || !!editing}
          onPress={() => setEditing("reject")}
        />
        <Button
          label={t("teachingHypothesesPanel.check")}
          accessibilityLabel={t("teachingHypothesesPanel.checkLabel")}
          kind="quiet"
          disabled={disabled || !!editing}
          onPress={() => void onRequestCheck()}
        />
      </View>
      {editing && (
        <View style={local.stack}>
          {editing === "correct" ? (
            <Field
              label={t("teachingHypothesesPanel.correction.label")}
              multiline
              maxLength={500}
              value={correction}
              editable={!disabled}
              onChangeText={setCorrection}
            />
          ) : (
            <Text style={styles.body}>
              {t("teachingHypothesesPanel.rejectHelp")}
            </Text>
          )}
          <Field
            label={t("teachingHypothesesPanel.note")}
            multiline
            maxLength={500}
            value={reason}
            editable={!disabled}
            onChangeText={setReason}
          />
          <View style={styles.row}>
            <Button
              label={t(
                editing === "correct"
                  ? "teachingHypothesesPanel.saveCorrection"
                  : "teachingHypothesesPanel.confirmReject",
              )}
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
            <Button
              label={t("teachingHypothesesPanel.cancel")}
              kind="quiet"
              disabled={disabled}
              onPress={close}
            />
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
  const t = useI18n().t;
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
      <Badge label={t("teachingHypothesesPanel.probe.badge")} tone="sand" />
      <Text accessibilityRole="header" style={styles.heading}>
        {question.prompt}
      </Text>
      {question.type === "choice" ? (
        <ChoiceList
          label={t("teachingHypothesesPanel.probe.answer")}
          options={question.options.map((o) => ({ id: o.id, label: o.text }))}
          value={value}
          disabled={disabled}
          onChange={setValue}
        />
      ) : (
        <Field
          label={
            question.unit
              ? t("teachingHypothesesPanel.probe.answerUnit", {
                  unit: question.unit,
                })
              : t("teachingHypothesesPanel.probe.answer")
          }
          keyboardType="numeric"
          value={value}
          editable={!disabled}
          onChangeText={setValue}
        />
      )}
      <View style={styles.row}>
        <Button
          label={t("teachingHypothesesPanel.probe.submit")}
          kind="primary"
          disabled={disabled || answer === null || answer === ""}
          onPress={() => void onAnswer({ answer: answer! })}
        />
        <Button
          label={t("teachingHypothesesPanel.probe.dontKnow")}
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
  const t = useI18n().t;
  const [objectiveId, setObjectiveId] = useState(objectives[0]?.id ?? "");
  const [note, setNote] = useState("");
  if (!objectives.length) return null;
  return (
    <Disclosure
      show={t("teachingHypothesesPanel.ask.show")}
      hide={t("teachingHypothesesPanel.ask.hide")}
    >
      <View style={local.stack}>
        <ChoiceList
          label={t("teachingHypothesesPanel.ask.objective")}
          options={objectives.map((o) => ({ id: o.id, label: o.description }))}
          value={objectiveId}
          disabled={disabled}
          onChange={setObjectiveId}
        />
        <Field
          label={t("teachingHypothesesPanel.ask.note")}
          multiline
          maxLength={500}
          value={note}
          editable={!disabled}
          onChangeText={setNote}
        />
        <Text style={styles.small}>
          {t("teachingHypothesesPanel.ask.help")}
        </Text>
        <Button
          label={t("teachingHypothesesPanel.ask.submit")}
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
  show,
  hide,
  children,
}: {
  show: string;
  hide: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={local.stack}>
      <Button
        label={open ? hide : show}
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
