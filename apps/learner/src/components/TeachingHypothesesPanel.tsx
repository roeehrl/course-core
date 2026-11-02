import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, StyleSheet, Text, View } from "react-native";
import { CourseApiError, type ServerSnapshot } from "../client/apiClient";
import type {
  HypothesisClient,
  HypothesisDecision,
  HypothesisSnapshot,
  ProbeResult,
  ProbeRun,
  TeachingHypothesis,
} from "../client/hypothesisClient";
import { Button, ChoiceList, colors, Field, styles } from "./ui";
import { useReservedHeight } from "./reservedHeight";
import { Icon } from "./icons/Icon";
import type { IconName } from "./icons/icons";
import { LongAnswerComposer } from "../connected/ui/LongAnswerComposer";
import { PillButton } from "../connected/ui/PillButton";
import { StatusLine } from "../connected/ui/StatusLine";
import { Tag } from "../connected/ui/Tag";
import { colors as tokens } from "../theme/colors";
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
/** A status chip's icon: being checked, supported, set aside or ruled out. */
function statusIcon(h: TeachingHypothesis): IconName {
  if (h.status === "rejected") return h.rejectedBy === "supervisor" ? "pause-circle" : "x";
  if (h.status === "confirmed" || h.status === "resolved") return "check";
  if (h.status === "expired") return "clock";
  return "clock";
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
      {/* One status line each: a failure (announced at once) and a confirmation, never a coloured box. */}
      {!!error && (
        <View accessibilityRole="alert" aria-live="assertive">
          <StatusLine tone="error" icon="alert-circle" text={error} />
        </View>
      )}
      {!!notice && (
        <View accessibilityLiveRegion="polite" aria-live="polite">
          <StatusLine tone="ink" icon="check" text={notice} />
        </View>
      )}
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
              <View style={styles.row}>
                <Tag className="cc-prof-chip" icon={statusIcon(h)} label={statusLabel(h, t)} />
              </View>
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
        <Tag
          className="cc-prof-chip"
          icon="lightbulb"
          label={t(`teachingHypothesesPanel.kind.${h.kind}` as MessageKey)}
        />
        <Tag className="cc-prof-chip" icon={statusIcon(h)} label={statusLabel(h, t)} />
        {h.pinned && (
          <Tag className="cc-prof-chip" icon="lock" label={t("teachingHypothesesPanel.card.pinned")} />
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
      <View style={local.meta}>
      <View style={local.source}>
        {h.source === "supervisor" && <Icon name="sparkle" size={16} />}
        <Text style={styles.small}>
          {t(`teachingHypothesesPanel.source.${h.source}` as MessageKey)}
        </Text>
      </View>
      <Text style={styles.small}>
        {t("teachingHypothesesPanel.card.basis", {
          certainty: t(
            `teachingHypothesesPanel.certainty.${h.uncertainty}` as MessageKey,
          ),
          count: h.observations,
        })}
      </Text>
      {h.objectiveIds.length > 0 && (
        <Text style={styles.small}>
          {t("teachingHypothesesPanel.card.about", {
            objectives: i18n.list(h.objectiveIds.map(objectiveTitle), "unit"),
          })}
        </Text>
      )}
      </View>
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
              label={t("teachingHypothesesPanel.cancel")}
              kind="quiet"
              disabled={disabled}
              onPress={close}
            />
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
          </View>
        </View>
      )}
    </View>
  );
}

/**
 * A quick check the companion prepared (final design §4.13): it never counts toward progress and,
 * written by AI, it carries the Unverified pill. A number is answered in the long-answer composer
 * (Enter adds a line, Cmd/Ctrl+Enter or "Submit check" submits); a choice with its options.
 */
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
      : value.trim() !== "" && Number.isFinite(Number(value.trim()))
        ? Number(value.trim())
        : null;
  const ready = answer !== null && answer !== "";
  const label =
    question.type === "numeric" && question.unit
      ? t("teachingHypothesesPanel.probe.answerUnit", { unit: question.unit })
      : t("teachingHypothesesPanel.probe.answer");
  // A pill of the quick check's own (token) colours, readable on its surface in both themes.
  const dontKnow = (
    <PillButton
      label={t("teachingHypothesesPanel.probe.dontKnow")}
      disabled={disabled}
      onPress={() => void onAnswer({ abstain: true })}
    />
  );
  return (
    <View
      style={local.probe}
      {...(Platform.OS === "web" ? { dataSet: { prof: "quick-check" } } : {})}
    >
      <View style={local.probeHead}>
        <View style={local.source}>
          <Icon name="practice" size={16} />
          <Text style={local.probeBadge}>{t("teachingHypothesesPanel.probe.badge")}</Text>
        </View>
        <Tag className="cc-prof-chip cc-prof-unverified" icon="info" label={t("teachingHypothesesPanel.probe.unverified")} />
      </View>
      <Text accessibilityRole="header" style={[styles.heading, local.probeText]}>
        {question.prompt}
      </Text>
      {question.type === "choice" ? (
        <>
          <ChoiceList
            label={label}
            options={question.options.map((o) => ({ id: o.id, label: o.text }))}
            value={value}
            disabled={disabled}
            onChange={setValue}
          />
          <View style={local.probeActions}>
            {dontKnow}
            <PillButton
              variant="accent"
              label={t("teachingHypothesesPanel.probe.submit")}
              disabled={disabled || !ready}
              onPress={() => void onAnswer({ answer: answer! })}
            />
          </View>
        </>
      ) : (
        <View style={local.probeComposer}>
          <LongAnswerComposer
            className="cc-prof-composer"
            label={label}
            value={value}
            onChange={setValue}
            disabled={disabled}
            submitLabel={t("teachingHypothesesPanel.probe.submit")}
            onSubmit={() => {
              if (ready) void onAnswer({ answer: answer! });
            }}
            secondary={{ label: t("teachingHypothesesPanel.probe.dontKnow"), disabled, onPress: () => void onAnswer({ abstain: true }) }}
          />
        </View>
      )}
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
        style={local.start}
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
  probe: {
    padding: 16,
    borderRadius: 12,
    backgroundColor: tokens.surface2,
    gap: 12,
    minWidth: 0,
  },
  probeText: { color: tokens.ink },
  // Text buttons start at the reading edge, never centred across the panel.
  start: { alignSelf: "flex-start" },
  probeHead: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 },
  // The kind line wraps inside the quick check on a phone instead of running past it.
  probeBadge: { color: tokens.ink, fontSize: 13, lineHeight: 20, fontWeight: "600", flexShrink: 1 },
  probeActions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  probeComposer: { gap: 4, alignItems: "stretch" },
  source: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1, minWidth: 0 },
  meta: { gap: 2 },
  reference: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 20,
    flexShrink: 1,
  },
});
