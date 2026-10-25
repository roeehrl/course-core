import React from "react";
import { Text, View } from "react-native";
import { canOpenStep } from "../domain/session";
import type {
  LearnerSnapshot,
  Lesson,
  MutationResult,
  Step,
} from "../domain/types";
import { useI18n } from "../i18n";
import { Badge, Button, ChoiceList, colors, Field, Notice, Eyebrow, styles, Heading, textDirection, webDir } from "./ui";

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
  const i18n = useI18n(),
    t = i18n.t;
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
          label={t("lessonFlow.backToRoadmap")}
          onPress={onBack}
          kind="quiet"
          disabled={pending}
        />
        <Text style={styles.small}>
          {t("lessonFlow.meta", { minutes: lesson.minutes, title: lesson.title })}
        </Text>
      </View>
      <View
        accessibilityLabel={t("lessonFlow.steps")}
        style={[styles.row, { alignItems: "stretch", gap: 8 }]}
      >
        {lesson.steps.map((item, i) => (
          <View
            key={item.id}
            style={{ flexGrow: 1, minWidth: compact ? "42%" : 100 }}
          >
            <Button
              label={t("lessonFlow.stepButton", {
                mark: progress.completedStepIds.includes(item.id) ? "✓" : i18n.number(i + 1),
                title: item.title,
              })}
              accessibilityLabel={t(
                item.id === step.id ? "lessonFlow.stepLabelCurrent" : "lessonFlow.stepLabel",
                { title: item.title, requirement: item.requirement },
              )}
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
              {item.requirement === "optional"
                ? t("lessonFlow.optionalDetour")
                : t("lessonFlow.required")}
            </Text>
          </View>
        ))}
      </View>
      {/* The step's own text in its own direction: its label, heading and body share one start
          edge, in a Hebrew interface too. */}
      <View {...webDir(textDirection(step.eyebrow, step.heading, step.body))} style={{ gap: 14 }}>
        <View style={styles.spread}>
          <Eyebrow>{step.eyebrow}</Eyebrow>
          <Badge
            label={t("lessonFlow.badge", { requirement: step.requirement, kind: step.kind })}
            tone={step.requirement === "optional" ? "lilac" : "mint"}
          />
        </View>
        <Heading
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
        </Heading>
        <Text style={styles.body}>{step.body}</Text>
      </View>
      {step.kind === "reading" && step.diagram && (
        <View
          accessibilityRole="image"
          accessibilityLabel={t("lessonFlow.diagram", {
            label: step.diagram.label,
            values: i18n.list(step.diagram.values.map((value) => i18n.number(value)), "unit"),
            caption: step.diagram.caption,
          })}
          style={{
            borderRadius: 20,
            backgroundColor: colors.stage,
            overflow: "hidden",
          }}
        >
          <Eyebrow style={{ color: "#9CE2CA", padding: 22 }}>
            {step.diagram.label}
          </Eyebrow>
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
                  {i18n.number(value)}
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
        <Notice>{t("lessonFlow.complete")}</Notice>
      )}
      {progress.status === "placed" && (
        <Notice>
          {t("lessonFlow.placed")}
        </Notice>
      )}
      <View style={{ gap: 12 }}>
        <View style={styles.divider} />
        <View style={[styles.spread, { paddingTop: 10 }]}>
          <View style={{ flex: 1, minWidth: 160, gap: 4 }}>
            <Text style={styles.small}>
              {last ? t("lessonFlow.last") : t("lessonFlow.upNext")}
            </Text>
            <Text
              style={[styles.small, { fontWeight: "600", color: colors.ink }]}
            >
              {next
                ? next.requirement === "optional"
                  ? t("lessonFlow.nextOptional", { title: next.title })
                  : next.title
                : t("lessonFlow.backToPath")}
            </Text>
          </View>
          <Button
            label={
              pending
                ? t("lessonFlow.saving")
                : canContinue
                  ? last
                    ? t("lessonFlow.returnToRoadmap")
                    : t("lessonFlow.continue")
                  : step.kind === "reading"
                    ? t("lessonFlow.markRead")
                    : step.kind === "choice"
                      ? t("lessonFlow.checkAnswer")
                      : t("lessonFlow.saveReflection")
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
            label={t("lessonFlow.skip")}
            kind="quiet"
            disabled={pending}
            onPress={onContinue}
          />
        )}
        <Text style={styles.small}>
          {step.requirement === "optional"
            ? t("lessonFlow.note.optional")
            : t("lessonFlow.note.required")}
        </Text>
      </View>
    </View>
  );
}
