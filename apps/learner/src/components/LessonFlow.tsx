import React from "react";
import { Text, View } from "react-native";
import { canOpenStep } from "../domain/session";
import type {
  LearnerSnapshot,
  Lesson,
  MutationResult,
  Step,
} from "../domain/types";
import { Badge, Button, ChoiceList, colors, Field, Notice, styles } from "./ui";

export function LessonFlow({
  lesson,
  step,
  snapshot,
  compact,
  answer,
  feedback,
  pending,
  onAnswer,
  onStep,
  onSubmit,
  onContinue,
  onBack,
}: {
  lesson: Lesson;
  step: Step;
  snapshot: LearnerSnapshot;
  compact: boolean;
  answer: string;
  feedback?: MutationResult["feedback"];
  pending: boolean;
  onAnswer: (value: string) => void;
  onStep: (id: string) => void;
  onSubmit: () => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const progress = snapshot.lessons[lesson.id]!;
  const index = lesson.steps.findIndex((item) => item.id === step.id);
  const completed = progress.completedStepIds.includes(step.id);
  const canContinue = completed || progress.status === "placed";
  const last = index === lesson.steps.length - 1;
  const next = lesson.steps[index + 1];
  return (
    <View style={{ gap: 24 }}>
      <View style={styles.spread}>
        <Button
          label="← Course roadmap"
          onPress={onBack}
          kind="quiet"
          disabled={pending}
        />
        <Text style={styles.small}>
          {lesson.minutes} min · {lesson.title}
        </Text>
      </View>
      <View
        accessibilityLabel="Lesson steps"
        style={[styles.row, { alignItems: "stretch", gap: 8 }]}
      >
        {lesson.steps.map((item, i) => (
          <View
            key={item.id}
            style={{ flexGrow: 1, minWidth: compact ? "42%" : 100 }}
          >
            <Button
              label={`${progress.completedStepIds.includes(item.id) ? "✓" : i + 1}  ${item.title}`}
              accessibilityLabel={`${item.title}, ${item.requirement} step${item.id === step.id ? ", current" : ""}`}
              selected={item.id === step.id}
              kind={item.id === step.id ? "primary" : "secondary"}
              disabled={pending || !canOpenStep(lesson, item.id, snapshot)}
              onPress={() => onStep(item.id)}
            />
            <Text
              style={[
                styles.small,
                { textAlign: "center", fontSize: 11, marginTop: 5 },
              ]}
            >
              {item.requirement === "optional" ? "Optional detour" : "Required"}
            </Text>
          </View>
        ))}
      </View>
      <View style={{ gap: 14 }}>
        <View style={styles.spread}>
          <Text style={styles.eyebrow}>{step.eyebrow}</Text>
          <Badge
            label={`${step.requirement === "required" ? "Required" : "Optional"} · ${step.kind === "choice" ? "check" : step.kind === "reflection" ? "reflection" : "explanation"}`}
            tone={step.requirement === "optional" ? "lilac" : "mint"}
          />
        </View>
        <Text
          accessibilityRole="header"
          style={{
            color: colors.ink,
            fontWeight: "700",
            fontSize: compact ? 32 : 42,
            lineHeight: compact ? 39 : 49,
            letterSpacing: -1.2,
          }}
        >
          {step.heading}
        </Text>
        <Text style={styles.body}>{step.body}</Text>
      </View>
      {step.kind === "reading" && step.diagram && (
        <View
          accessibilityRole="image"
          accessibilityLabel={`${step.diagram.label}: ${step.diagram.values.join(", ")}. ${step.diagram.caption}`}
          style={{
            borderRadius: 20,
            backgroundColor: colors.stage,
            overflow: "hidden",
          }}
        >
          <Text style={[styles.eyebrow, { color: "#9CE2CA", padding: 22 }]}>
            {step.diagram.label}
          </Text>
          <View
            style={{
              flexDirection: "row",
              alignItems: "flex-end",
              justifyContent: "center",
              gap: compact ? 14 : 26,
              paddingHorizontal: 22,
              paddingTop: 22,
              paddingBottom: 28,
              minHeight: 185,
            }}
          >
            {step.diagram.values.map((value, i) => (
              <View
                key={i}
                style={{ flex: 1, maxWidth: 90, gap: 12, alignItems: "center" }}
              >
                <View
                  style={{
                    width: "100%",
                    height:
                      28 +
                      (Math.abs(value) /
                        Math.max(1, ...step.diagram!.values.map(Math.abs))) *
                        92,
                    backgroundColor: i % 2 ? "#D4B7F0" : "#99DFC5",
                    borderRadius: 8,
                  }}
                />
                <Text
                  style={{ color: "#F0F9F5", fontSize: 24, fontWeight: "600" }}
                >
                  {value}
                </Text>
              </View>
            ))}
          </View>
          <Text
            style={{
              borderTopWidth: 1,
              borderColor: "#466167",
              padding: 20,
              color: "#E0EEEA",
              fontSize: 14,
              lineHeight: 23,
            }}
          >
            {step.diagram.caption}
          </Text>
        </View>
      )}
      {step.kind === "choice" && (
        <ChoiceList
          label={step.heading}
          options={step.options}
          value={answer}
          onChange={onAnswer}
          disabled={pending || completed}
        />
      )}
      {step.kind === "reflection" && (
        <Field
          label={step.prompt}
          placeholder={step.placeholder}
          multiline
          value={answer}
          onChangeText={onAnswer}
          maxLength={4000}
          editable={!pending && !completed}
        />
      )}
      {feedback && (
        <Notice error={feedback.outcome === "retry"}>{feedback.message}</Notice>
      )}
      {completed && !feedback && (
        <Notice>This step is complete. You can review it and continue.</Notice>
      )}
      {progress.status === "placed" && (
        <Notice>
          Available for review through placement. Reviewing is optional.
        </Notice>
      )}
      <View style={{ gap: 12 }}>
        <View style={styles.divider} />
        <View style={[styles.spread, { paddingTop: 10 }]}>
          <View style={{ flex: 1, minWidth: 160, gap: 4 }}>
            <Text style={styles.small}>
              {last ? "You’re at the last step" : "Up next"}
            </Text>
            <Text
              style={[styles.small, { fontWeight: "600", color: colors.ink }]}
            >
              {next
                ? `${next.title}${next.requirement === "optional" ? " · optional" : ""}`
                : "Back to your learning path"}
            </Text>
          </View>
          <Button
            label={
              pending
                ? "Saving…"
                : canContinue
                  ? last
                    ? "Return to roadmap →"
                    : "Continue →"
                  : step.kind === "reading"
                    ? "Mark read & continue →"
                    : step.kind === "choice"
                      ? "Check answer"
                      : "Save reflection"
            }
            kind="primary"
            onPress={canContinue ? onContinue : onSubmit}
            disabled={
              pending ||
              (step.kind !== "reading" && !answer.trim() && !canContinue)
            }
            style={compact ? { width: "100%" } : undefined}
          />
        </View>
        {step.requirement === "optional" && !canContinue && (
          <Button
            label="Skip for now →"
            kind="quiet"
            disabled={pending}
            onPress={onContinue}
          />
        )}
        <Text style={styles.small}>
          {step.requirement === "optional"
            ? "This side path is optional. Skipping it never blocks your next step."
            : "Required steps open in order. Your answer and place are saved on this device."}
        </Text>
      </View>
    </View>
  );
}
