import React from "react";
import { Text, View } from "react-native";
import { AssessmentInput } from "../connected/AssessmentInput";
import { PLACEMENT_PANEL_ID } from "../client/presentation";
import { MarkdownContent } from "./MarkdownContent";
import { useI18n, type MessageKey } from "../i18n";
import { abstainHint, placementReason, retakeState, unavailableMessage, usePlacementRun, type PlacementRunProps } from "./placementRunState";
import { Button, colors, Notice, styles } from "./ui";

export type { PlacementRunProps } from "./placementRunState";

const ABSTAIN_HINT_ID = "placement-abstain-hint";

/** Native placement: the same optional, bounded, resumable run as the web panel, on native
 * controls. Every item type is answered here, including units and "I don't know yet".
 * Written answers' review threads are not shown natively yet (see ReviewStatus, web only). */
export function PlacementRun(props: PlacementRunProps) {
  const i18n = useI18n(),
    t = i18n.t;
  const { view, item, answer, setAnswer, busy, error, open, unavailable, draftProblem, actions } = usePlacementRun(props);
  if (unavailable)
    return (
      <View style={styles.card} aria-labelledby="placement-title">
        <Text style={styles.eyebrow}>{t("placementRun.eyebrow")}</Text>
        <Heading>{t("placementRun.title.unavailable")}</Heading>
        <Notice error>{unavailableMessage(t)}</Notice>
        <View style={styles.row}>
          <Button label={t("placementRun.retry")} kind="secondary" disabled={busy} onPress={actions.retry} />
        </View>
      </View>
    );
  if (!view || !open) return null;
  const used = view.run?.itemsUsed ?? 0;
  const abstainable = item?.question.allowAbstain !== false;
  return (
    <View nativeID={PLACEMENT_PANEL_ID} style={styles.card} aria-labelledby="placement-title">
      <Text style={styles.eyebrow}>{t("placementRun.eyebrow")}</Text>
      {view.state === "offered" && (
        <>
          <Heading>{t("placementRun.offer.title")}</Heading>
          <Text style={styles.body}>{t("placementRun.offer.body", { max: view.maxItems })}</Text>
          <View style={styles.row}>
            <Button label={t("placementRun.findStart")} kind="primary" disabled={busy} onPress={actions.start} />
            <Button label={t("placementRun.fromBeginning")} kind="quiet" disabled={busy} onPress={actions.decline} />
          </View>
        </>
      )}
      {view.state === "in_progress" && (
        <>
          <Heading>
            {t("placementRun.question", { n: Math.min(used + 1, view.maxItems), max: view.maxItems })}
          </Heading>
          {!item && view.run?.nextItem && (
            <Button
              label={view.run.pendingChallengeId ? t("placementRun.resume") : t("placementRun.next")}
              kind="primary"
              disabled={busy}
              onPress={actions.next}
            />
          )}
          {item && (
            <View style={{ gap: 14 }}>
              <MarkdownContent markdown={item.question.prompt} />
              <AssessmentInput question={item.question} answer={answer} pending={busy} onChange={setAnswer} />
              <View style={styles.row}>
                <Button label={t("placementRun.save")} kind="primary" disabled={busy || Boolean(draftProblem)} onPress={actions.answer} />
                {abstainable && (
                  <Button
                    label={t("placementRun.abstain")}
                    kind="secondary"
                    disabled={busy}
                    accessibilityHint={abstainHint(t)}
                    describedBy={ABSTAIN_HINT_ID}
                    onPress={actions.abstain}
                  />
                )}
              </View>
              {abstainable && (
                <Text nativeID={ABSTAIN_HINT_ID} style={styles.small}>
                  {abstainHint(t)}
                </Text>
              )}
            </View>
          )}
          {!view.run?.nextItem && !item && (
            <Text style={styles.body}>{placementReason(view.run?.stopReason, i18n) ?? t("placementRun.complete")}</Text>
          )}
          <Button
            label={view.run?.nextItem || item ? t("placementRun.stopAndSee") : t("placementRun.seeResult")}
            kind="quiet"
            disabled={busy}
            onPress={actions.finish}
          />
        </>
      )}
      {view.state === "finished" && view.run && (
        <>
          <Heading>{t("placementRun.result.title")}</Heading>
          {!!placementReason(view.run.stopReason, i18n) && (
            <Text style={styles.body}>{placementReason(view.run.stopReason, i18n)}</Text>
          )}
          {view.run.proposal.exempt.length ? (
            <>
              <Text style={styles.body}>{t("placementRun.result.exempt")}</Text>
              <View role="list" style={{ gap: 4 }}>
                {view.run.proposal.exempt.map((e) => (
                  <Text key={e.episodeId} role="listitem" style={[styles.body, { color: colors.ink }]}>
                    • {e.title}
                  </Text>
                ))}
              </View>
              <Text style={styles.small}>{t("placementRun.result.shownIntro")}</Text>
              <Bullets
                rows={view.run.proposal.demonstrated.map((d) => ({
                  key: d.objectiveId,
                  text: d.description,
                  note: d.supportingItems?.length
                    ? t("placementRun.result.supportedBy", { count: d.supportingItems.length })
                    : undefined,
                  children: d.supportingItems?.map((item) => ({ key: item.assessmentId, text: item.prompt })),
                }))}
              />
            </>
          ) : (
            <Text style={styles.body}>{t("placementRun.result.nothing")}</Text>
          )}
          {(view.run.proposal.pending?.length ?? 0) > 0 && (
            <Text style={styles.small}>
              {t("placementRun.result.pending", {
                list: view.run.proposal.pending!.map((p) => p.description).join(" "),
              })}
            </Text>
          )}
          {(view.run.proposal.notShown?.length ?? 0) > 0 && (
            <>
              <Text style={styles.small}>{t("placementRun.result.notShownIntro")}</Text>
              <Bullets
                rows={view.run.proposal.notShown!.map((o) => ({
                  key: o.objectiveId,
                  text: o.description,
                  note: t(`placementRun.result.notShown.${o.reason}` as MessageKey, { count: o.questions }),
                }))}
              />
            </>
          )}
          {(view.run.proposal.untested?.length ?? 0) > 0 && (
            <>
              <Text style={styles.small}>
                {t("placementRun.result.untestedIntro", {
                  count: view.run.proposal.untestedCount ?? view.run.proposal.untested!.length,
                })}
              </Text>
              <Bullets rows={view.run.proposal.untested!.map((o) => ({ key: o.objectiveId, text: o.description }))} />
            </>
          )}
          <Text style={styles.small}>{t("placementRun.result.untestedNote")}</Text>
          <Retake retake={retakeState(view, i18n)} busy={busy} onRetake={actions.start} />
          <View style={styles.row}>
            {view.run.proposal.exempt.length > 0 && (
              <Button
                label={
                  view.run.proposal.startTitle
                    ? t("placementRun.startAt", { title: view.run.proposal.startTitle })
                    : t("placementRun.placeOutAll")
                }
                kind="primary"
                disabled={busy}
                onPress={actions.acceptProposal}
              />
            )}
            <Button
              label={t("placementRun.fromBeginning")}
              kind={view.run.proposal.exempt.length ? "quiet" : "primary"}
              disabled={busy}
              onPress={actions.startFromBeginning}
            />
          </View>
        </>
      )}
      {!!error && <Notice error>{error}</Notice>}
    </View>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <Text nativeID="placement-title" accessibilityRole="header" aria-level={2} style={styles.heading}>
      {children}
    </Text>
  );
}

function Retake({ retake, busy, onRetake }: { retake: ReturnType<typeof retakeState>; busy: boolean; onRetake: () => void }) {
  const t = useI18n().t;
  if (!retake) return null;
  if (!retake.allowed) return <Text style={styles.small}>{retake.text}</Text>;
  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.body}>{retake.text}</Text>
      <Button label={t("placementRun.retake")} kind="secondary" disabled={busy} onPress={onRetake} />
    </View>
  );
}

interface BulletRow {
  key: string;
  /** Course text (objective descriptions, item prompts), shown in its own direction. */
  text: string;
  note?: string;
  children?: { key: string; text: string }[];
}
/** A native list of course text with an optional note and nested rows (the questions behind it). */
function Bullets({ rows }: { rows: BulletRow[] }) {
  return (
    <View role="list" style={{ gap: 6 }}>
      {rows.map((row) => (
        <View key={row.key} role="listitem" style={{ gap: 2 }}>
          <Text style={[styles.body, { color: colors.ink }]}>
            • <Text style={{ writingDirection: "auto" }}>{row.text}</Text>
            {row.note ? <Text style={styles.small}> {row.note}</Text> : null}
          </Text>
          {row.children?.length ? (
            <View role="list" style={{ gap: 2, paddingStart: 16 }}>
              {row.children.map((child) => (
                <Text key={child.key} role="listitem" style={[styles.small, { writingDirection: "auto" }]}>
                  ◦ {child.text}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}
