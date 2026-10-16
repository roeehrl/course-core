import React from "react";
import { Text, View } from "react-native";
import { AssessmentInput } from "../connected/AssessmentInput";
import { PLACEMENT_PANEL_ID } from "../client/presentation";
import { MarkdownContent } from "./MarkdownContent";
import { ABSTAIN_HINT, placementReasons as reasons, retakeState, usePlacementRun, type PlacementRunProps } from "./placementRunState";
import { Button, colors, Notice, styles } from "./ui";

export type { PlacementRunProps } from "./placementRunState";

const ABSTAIN_HINT_ID = "placement-abstain-hint";

/** Native placement: the same optional, bounded, resumable run as the web panel, on native
 * controls. Every item type is answered here, including units and "I don't know yet".
 * Written answers' review threads are not shown natively yet (see ReviewStatus, web only). */
export function PlacementRun(props: PlacementRunProps) {
  const { view, item, answer, setAnswer, busy, error, open, draftProblem, actions } = usePlacementRun(props);
  if (!view || !open) return null;
  const used = view.run?.itemsUsed ?? 0;
  const abstainable = item?.question.allowAbstain !== false;
  return (
    <View nativeID={PLACEMENT_PANEL_ID} style={styles.card} aria-labelledby="placement-title">
      <Text style={styles.eyebrow}>Optional · find your starting point</Text>
      {view.state === "offered" && (
        <>
          <Heading>Already know some of this?</Heading>
          <Text style={styles.body}>
            Answer up to {view.maxItems} short questions without help. If you show what an early part of the course teaches, you
            can start later. Nothing is skipped until you choose, you can stop at any time, and you can always revisit material
            you skip. Declining is completely fine.
          </Text>
          <View style={styles.row}>
            <Button label="Find my starting point" kind="primary" disabled={busy} onPress={actions.start} />
            <Button label="Start from the beginning" kind="quiet" disabled={busy} onPress={actions.decline} />
          </View>
        </>
      )}
      {view.state === "in_progress" && (
        <>
          <Heading>
            Placement question {Math.min(used + 1, view.maxItems)} of at most {view.maxItems}
          </Heading>
          {!item && view.run?.nextItem && (
            <Button
              label={view.run.pendingChallengeId ? "Resume my question" : "Next question"}
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
                <Button label="Save answer" kind="primary" disabled={busy || Boolean(draftProblem)} onPress={actions.answer} />
                {abstainable && (
                  <Button
                    label="I don't know yet"
                    kind="secondary"
                    disabled={busy}
                    accessibilityHint={ABSTAIN_HINT}
                    describedBy={ABSTAIN_HINT_ID}
                    onPress={actions.abstain}
                  />
                )}
              </View>
              {abstainable && (
                <Text nativeID={ABSTAIN_HINT_ID} style={styles.small}>
                  {ABSTAIN_HINT}
                </Text>
              )}
            </View>
          )}
          {!view.run?.nextItem && !item && <Text style={styles.body}>{reasons[view.run?.stopReason ?? ""] ?? "Placement is complete."}</Text>}
          <Button label={view.run?.nextItem || item ? "Stop and see my result" : "See my result"} kind="quiet" disabled={busy} onPress={actions.finish} />
        </>
      )}
      {view.state === "finished" && view.run && (
        <>
          <Heading>Your placement result</Heading>
          {!!reasons[view.run.stopReason] && <Text style={styles.body}>{reasons[view.run.stopReason]}</Text>}
          {view.run.proposal.exempt.length ? (
            <>
              <Text style={styles.body}>You showed what these parts teach and can place out of them:</Text>
              <View role="list" style={{ gap: 4 }}>
                {view.run.proposal.exempt.map((e) => (
                  <Text key={e.episodeId} role="listitem" style={[styles.body, { color: colors.ink }]}>
                    • {e.title}
                  </Text>
                ))}
              </View>
              <Text style={styles.small}>Shown independently: {view.run.proposal.demonstrated.map((d) => d.description).join(" ")}</Text>
            </>
          ) : (
            <Text style={styles.body}>Nothing will be skipped. Starting from the beginning is the right path.</Text>
          )}
          {(view.run.proposal.pending?.length ?? 0) > 0 && (
            <Text style={styles.small}>
              Waiting for evaluation, not marked wrong: {view.run.proposal.pending!.map((p) => p.description).join(" ")}
            </Text>
          )}
          <Text style={styles.small}>{view.run.proposal.untestedNote}</Text>
          <Retake retake={retakeState(view)} busy={busy} onRetake={actions.start} />
          <View style={styles.row}>
            {view.run.proposal.exempt.length > 0 && (
              <Button
                label={view.run.proposal.startTitle ? `Start at “${view.run.proposal.startTitle}”` : "Place out of everything shown"}
                kind="primary"
                disabled={busy}
                onPress={actions.acceptProposal}
              />
            )}
            <Button
              label="Start from the beginning"
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
  if (!retake) return null;
  if (!retake.allowed) return <Text style={styles.small}>{retake.text}</Text>;
  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.body}>{retake.text}</Text>
      <Button label="Retake placement" kind="secondary" disabled={busy} onPress={onRetake} />
    </View>
  );
}
