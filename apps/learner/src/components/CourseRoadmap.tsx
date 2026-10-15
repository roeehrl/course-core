import React, { useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { resumeLesson } from "../domain/session";
import type {
  Course,
  LearnerSnapshot,
  Lesson,
} from "../domain/types";
import { Badge, Button, colors, styles } from "./ui";
import type { PolicyCoverage } from "../client/policyClient";

/** What the roadmap shows for one lesson. Under review and optional detour are
 * distinct from the progress status so they are never conveyed by colour alone. */
export type RoadmapState =
  | "current"
  | "completed"
  | "placed"
  | "locked"
  | "under_review"
  | "optional_detour"
  | "available";
export const roadmapLabels: Record<RoadmapState, string> = {
  current: "Current",
  completed: "Completed",
  placed: "Placed out",
  locked: "Locked",
  under_review: "Under review",
  optional_detour: "Optional detour",
  available: "Ready to begin",
};
export const roadmapMarks: Record<RoadmapState, string> = {
  current: "●",
  completed: "✓",
  placed: "↗",
  locked: "○",
  under_review: "…",
  optional_detour: "◇",
  available: "○",
};
export function roadmapState(
  lesson: Lesson,
  progress: LearnerSnapshot["lessons"][string] | undefined,
  resumeId: string | undefined,
): RoadmapState {
  const status = progress?.status ?? "locked";
  if (status === "completed" || status === "placed") return status;
  if (progress?.underReview) return "under_review";
  if (lesson.id === resumeId) return "current";
  if (status === "locked") return "locked";
  return lesson.requirement === "optional" ? "optional_detour" : "available";
}
/** Sections grouped by their author-defined stage, in stage order. Sections
 * without a known stage keep their own order after the staged ones. */
function stageGroups(course: Course) {
  const stages = course.stages ?? [];
  const known = new Set(stages.map((stage) => stage.id));
  const groups = stages
    .map((stage) => ({
      stage,
      sections: course.sections.filter((section) => section.stageId === stage.id),
    }))
    .filter((group) => group.sections.length > 0);
  const rest = course.sections.filter((section) => !section.stageId || !known.has(section.stageId));
  return rest.length ? [...groups, { stage: undefined, sections: rest }] : groups;
}
/** "3 of 5 core objectives covered" plus personal extras on their own line,
 * stated so extras never read as part of completion. */
export function coverageText(coverage: PolicyCoverage) {
  const extras = coverage.personalExtras.committed.count + coverage.personalExtras.reserved.count;
  return {
    core: `${coverage.coveredCoreObjectives} of ${coverage.denominator} core objective${coverage.denominator === 1 ? "" : "s"} covered`,
    extras: extras
      ? `${extras} personal extra${extras === 1 ? "" : "s"} added for you — optional support that does not change what completing the course requires`
      : undefined,
  };
}
export function CourseRoadmap({
  course,
  snapshot,
  compact,
  coverage,
  onOpenLesson,
  onPlacement,
}: {
  /** Server coverage with a denominator fixed at enrollment. */
  coverage?: PolicyCoverage;
  course: Course;
  snapshot: LearnerSnapshot;
  compact: boolean;
  onOpenLesson: (lesson: Lesson) => void;
  onPlacement: () => void;
}) {
  const resume = resumeLesson(course, snapshot);
  const [selectedId, setSelectedId] = useState(
    resume?.id ?? course.lessons[0]?.id,
  );
  const selected = course.lessons.find((lesson) => lesson.id === selectedId);
  const progress = selected && snapshot.lessons[selected.id];
  const completed = course.lessons.filter(
    (lesson) => snapshot.lessons[lesson.id]?.status === "completed",
  ).length;
  const placed = course.lessons.filter(
    (lesson) => snapshot.lessons[lesson.id]?.status === "placed",
  ).length;
  return (
    <View style={{ gap: 28 }}>
      <View style={{ gap: 14 }}>
        <Text style={styles.eyebrow}>Your learning journey</Text>
        <Text
          accessibilityRole="header"
          style={[local.hero, compact && { fontSize: 38, lineHeight: 44 }]}
        >
          {course.title}
        </Text>
        {course.subtitle ? (
          <Text style={[styles.heading, { fontWeight: "400" }]}>
            {course.subtitle}
          </Text>
        ) : null}
        <Text style={[styles.body, { maxWidth: 600 }]}>
          {course.description}
        </Text>
        <View style={[styles.row, { marginTop: 5 }]}>
          <Text style={styles.small}>{course.lessons.length} lessons</Text>
          <Text style={styles.small}>·</Text>
          <Text style={styles.small}>
            {course.lessons.reduce((sum, lesson) => sum + lesson.minutes, 0)}{" "}
            minutes
          </Text>
        </View>
      </View>
      <View style={[local.resume, compact && { alignItems: "stretch" }]}>
        <View style={{ flex: 1, minWidth: 150, gap: 6 }}>
          <Text style={styles.eyebrow}>
            {resume ? "Your next small step" : "A path worth finishing"}
          </Text>
          <Text style={styles.heading}>
            {resume?.title ?? "You reached the end."}
          </Text>
          <Text style={styles.small}>
            {resume
              ? "Pick up where you left off."
              : "Revisit any lesson and keep exploring."}
          </Text>
        </View>
        {resume && (
          <Button
            label="Continue learning →"
            kind="primary"
            onPress={() => onOpenLesson(resume)}
          />
        )}
      </View>
      <View style={{ gap: 14 }}>
        <View style={styles.spread}>
          <Text accessibilityRole="header" style={styles.heading}>
            Your learning path
          </Text>
          <Text style={styles.small}>
            {completed} completed{placed ? ` · ${placed} placed out` : ""} /{" "}
            {course.lessons.length}
          </Text>
        </View>
        {coverage && (
          <View style={{ gap: 4 }} testID="course-coverage">
            <Text style={[styles.body, { fontWeight: "600" }]}>{coverageText(coverage).core}</Text>
            {coverageText(coverage).extras && (
              <Text style={styles.small}>{coverageText(coverage).extras}</Text>
            )}
          </View>
        )}
        <View style={styles.row} role="list" aria-label="Lesson states">
          {(["current", "completed", "placed", "under_review", "optional_detour", "locked"] as const).map((state) => (
            <View role="listitem" key={state}>
              <Badge
                label={`${roadmapMarks[state]} ${roadmapLabels[state]}`}
                tone={state === "placed" || state === "optional_detour" ? "lilac" : state === "under_review" ? "sand" : state === "locked" ? "neutral" : "mint"}
              />
            </View>
          ))}
        </View>
      </View>
      <View style={{ gap: 18 }}>
        {stageGroups(course).map((group) => (
          <View key={group.stage?.id ?? "unstaged"} style={{ gap: 14 }}>
            {group.stage && (
              <View style={{ gap: 4 }}>
                <Text role="heading" aria-level={2} style={styles.title}>
                  {group.stage.title}
                </Text>
                {group.stage.summary ? <Text style={styles.small}>{group.stage.summary}</Text> : null}
              </View>
            )}
            {group.sections.map((section) => (
          <View
            key={section.id}
            style={[styles.card, { padding: compact ? 18 : 24 }]}
          >
            <View style={styles.spread}>
              <View style={{ flex: 1, gap: 5 }}>
                {section.subtitle ? (
                  <Text style={styles.eyebrow}>{section.subtitle}</Text>
                ) : null}
                <Text role="heading" aria-level={group.stage ? 3 : 2} style={styles.heading}>
                  {section.title}
                </Text>
                {section.description ? <Text style={styles.small}>{section.description}</Text> : null}
              </View>
              {section.iconAsset ? (
                <Image
                  source={{ uri: section.iconAsset }}
                  accessible={false}
                  aria-hidden
                  style={local.chapterMark}
                />
              ) : null}
            </View>
            <View
              role="list"
              aria-label={`Lessons in ${section.title}`}
              style={{
                flexDirection: compact ? "column" : "row",
                flexWrap: compact ? "nowrap" : "wrap",
                paddingTop: 14,
                paddingBottom: 4,
                gap: 12,
              }}
            >
              {section.lessonIds.map((id) => {
                const lesson = course.lessons.find((item) => item.id === id);
                if (!lesson) return null;
                const state = roadmapState(lesson, snapshot.lessons[id], resume?.id);
                const current = state === "current";
                return (
                  <View
                    role="listitem"
                    key={id}
                    style={
                      compact
                        ? { flexDirection: "row", alignItems: "center", gap: 14, minWidth: 0 }
                        : { flex: 1, minWidth: 120, alignItems: "center", gap: 10 }
                    }
                  >
                    <Button
                      accessibilityLabel={`Inspect ${lesson.title}, ${roadmapLabels[state]}`}
                      label={
                        state === "completed" || state === "placed" || state === "under_review"
                          ? roadmapMarks[state]
                          : String(course.lessons.indexOf(lesson) + 1).padStart(2, "0")
                      }
                      selected={id === selectedId}
                      kind={current ? "primary" : "secondary"}
                      onPress={() => setSelectedId(id)}
                      style={{
                        width: 58,
                        height: 58,
                        borderRadius: 29,
                        borderStyle: state === "optional_detour" || state === "locked" ? "dashed" : "solid",
                        borderColor:
                          id === selectedId ? colors.ink : colors.line,
                        backgroundColor: current
                          ? colors.teal
                          : state === "placed" || state === "optional_detour"
                            ? colors.lilac
                            : state === "under_review"
                              ? colors.sand
                              : state === "completed"
                                ? colors.mint
                                : colors.white,
                      }}
                    />
                    <View style={compact ? { flex: 1, minWidth: 0, gap: 2 } : { alignItems: "center", gap: 4 }}>
                      <Text
                        style={{
                          fontSize: 14,
                          fontWeight: "600",
                          textAlign: compact ? "left" : "center",
                          lineHeight: 21,
                          color: colors.ink,
                        }}
                      >
                        {lesson.title}
                      </Text>
                      <Text style={[styles.small, { textAlign: compact ? "left" : "center" }]}>
                        {current ? "Current · continue here" : roadmapLabels[state]}
                      </Text>
                      {lesson.personal && (
                        <Badge
                          label={lesson.requirement === "optional" ? "Personal · optional" : "Personal"}
                          tone="lilac"
                        />
                      )}
                    </View>
                  </View>
                );
              })}
            </View>
          </View>
            ))}
          </View>
        ))}
      </View>
      {selected && progress && (
        <View style={[styles.card, { backgroundColor: colors.paper }]}>
          <View style={styles.spread}>
            <Text style={styles.eyebrow}>Inside this lesson</Text>
            <Badge
              label={roadmapLabels[roadmapState(selected, progress, resume?.id)]}
              tone={
                progress.status === "placed"
                  ? "lilac"
                  : progress.status === "locked"
                    ? "neutral"
                    : progress.underReview
                      ? "sand"
                      : "mint"
              }
            />
          </View>
          <Text accessibilityRole="header" style={styles.title}>
            {selected.title}
          </Text>
          <Text style={styles.body}>{selected.description}</Text>
          <Text style={styles.small}>
            {selected.minutes} min ·{" "}
            {
              selected.steps.filter((step) => step.requirement === "required")
                .length
            }{" "}
            required steps ·{" "}
            {
              selected.steps.filter((step) => step.requirement === "optional")
                .length
            }{" "}
            optional
          </Text>
          {progress.status === "locked" ? (
            <View style={{ gap: 10 }}>
              <Text style={styles.small}>
                {progress.reason ?? "This lesson is not available yet."}
              </Text>
              <Button label="Lesson locked" disabled onPress={() => {}} />
            </View>
          ) : (
            <Button
              label={
                progress.status === "placed" || progress.status === "completed"
                  ? "Revisit lesson →"
                  : "Open lesson →"
              }
              onPress={() => onOpenLesson(selected)}
            />
          )}
        </View>
      )}
      {course.placement && (
        <View
          style={[
            styles.card,
            { backgroundColor: colors.lilac, borderColor: colors.lilac },
          ]}
        >
          <Badge label="Optional placement" tone="lilac" />
          <Text accessibilityRole="header" style={styles.heading}>
            {course.placement.title}
          </Text>
          <Text style={styles.body}>{course.placement.description}</Text>
          <Button
            label="Explore placement ↗"
            onPress={onPlacement}
            style={{ alignSelf: "flex-start" }}
          />
        </View>
      )}
    </View>
  );
}
const local = StyleSheet.create({
  hero: {
    fontSize: 52,
    lineHeight: 60,
    letterSpacing: -2,
    color: colors.ink,
    fontWeight: "700",
  },
  resume: {
    backgroundColor: colors.mint,
    borderRadius: 18,
    padding: 24,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 20,
  },
  chapterMark: {
    width: 44,
    height: 44,
    backgroundColor: colors.mint,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
});
