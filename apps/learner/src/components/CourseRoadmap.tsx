import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { resumeLesson } from "../domain/session";
import type {
  Course,
  LearnerSnapshot,
  Lesson,
  LessonStatus,
} from "../domain/types";
import { Badge, Button, colors, styles } from "./ui";

const statusLabels: Record<LessonStatus, string> = {
  available: "Ready to begin",
  locked: "Locked",
  completed: "Completed",
  placed: "Placed out",
};
export function CourseRoadmap({
  course,
  snapshot,
  compact,
  onOpenLesson,
  onPlacement,
}: {
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
        <Text style={styles.eyebrow}>Your guided learning journey</Text>
        <Text
          accessibilityRole="header"
          style={[local.hero, compact && { fontSize: 38, lineHeight: 44 }]}
        >
          {course.title}
        </Text>
        <Text style={[styles.heading, { fontWeight: "400" }]}>
          {course.subtitle}
        </Text>
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
          <Text style={styles.small}>·</Text>
          <Text style={styles.small}>Your pace, your place</Text>
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
        <View style={styles.row}>
          <Badge label="● Current" />
          <Badge label="✓ Completed" />
          <Badge label="↗ Placed out" tone="lilac" />
          <Badge label="○ Locked" tone="neutral" />
        </View>
      </View>
      <View style={{ gap: 18 }}>
        {course.sections.map((section, sectionIndex) => (
          <View
            key={section.id}
            style={[styles.card, { padding: compact ? 18 : 24 }]}
          >
            <View style={styles.spread}>
              <View style={{ flex: 1, gap: 5 }}>
                <Text
                  style={[
                    styles.eyebrow,
                    sectionIndex % 2 === 1 && { color: colors.purple },
                  ]}
                >
                  Chapter {String(sectionIndex + 1).padStart(2, "0")}
                </Text>
                <Text accessibilityRole="header" style={styles.heading}>
                  {section.title}
                </Text>
                <Text style={styles.small}>{section.description}</Text>
              </View>
              <View
                style={[
                  local.chapterMark,
                  sectionIndex % 2 === 1 && { backgroundColor: colors.lilac },
                ]}
              >
                <Text
                  style={{
                    fontSize: 23,
                    color: sectionIndex % 2 === 1 ? colors.purple : colors.teal,
                  }}
                >
                  {sectionIndex % 2 ? "↗" : "≋"}
                </Text>
              </View>
            </View>
            <View
              style={{
                flexDirection:
                  compact && section.lessonIds.length > 2 ? "column" : "row",
                paddingTop: 14,
                paddingBottom: 4,
                gap: 12,
              }}
            >
              {section.lessonIds.map((id, index) => {
                const lesson = course.lessons.find((item) => item.id === id);
                if (!lesson) return null;
                const status = snapshot.lessons[id]?.status ?? "locked";
                const current = id === resume?.id;
                return (
                  <View
                    key={id}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      alignItems: "center",
                      gap: 10,
                      paddingTop: index % 2 && !compact ? 20 : 0,
                    }}
                  >
                    <Button
                      accessibilityLabel={`Inspect ${lesson.title}, ${statusLabels[status]}`}
                      label={
                        status === "completed"
                          ? "✓"
                          : status === "placed"
                            ? "↗"
                            : String(
                                course.lessons.indexOf(lesson) + 1,
                              ).padStart(2, "0")
                      }
                      selected={id === selectedId}
                      kind={current ? "primary" : "secondary"}
                      onPress={() => setSelectedId(id)}
                      style={{
                        width: 58,
                        height: 58,
                        borderRadius: 29,
                        borderColor:
                          id === selectedId ? colors.ink : colors.line,
                        backgroundColor: current
                          ? colors.teal
                          : status === "placed"
                            ? colors.lilac
                            : status === "completed"
                              ? colors.mint
                              : colors.white,
                      }}
                    />
                    <Text
                      style={{
                        fontSize: 14,
                        fontWeight: "600",
                        textAlign: "center",
                        lineHeight: 21,
                        color: colors.ink,
                      }}
                    >
                      {lesson.title}
                    </Text>
                    <Text style={[styles.small, { textAlign: "center" }]}>
                      {current ? "Continue here" : statusLabels[status]}
                    </Text>
                    <View
                      style={{
                        height: 3,
                        backgroundColor:
                          id === selectedId ? colors.teal : colors.line,
                        alignSelf: "stretch",
                        marginTop: 4,
                        borderRadius: 3,
                      }}
                    />
                  </View>
                );
              })}
            </View>
          </View>
        ))}
      </View>
      {selected && progress && (
        <View style={[styles.card, { backgroundColor: colors.paper }]}>
          <View style={styles.spread}>
            <Text style={styles.eyebrow}>Inside this lesson</Text>
            <Badge
              label={statusLabels[progress.status]}
              tone={
                progress.status === "placed"
                  ? "lilac"
                  : progress.status === "locked"
                    ? "neutral"
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
