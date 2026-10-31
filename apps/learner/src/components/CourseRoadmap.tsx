import React, { useId, useState } from "react";
import { Image, Platform, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { LivePressable, type LivePressableProps } from "./LivePressable";
import { resumeLesson } from "../domain/session";
import type {
  Course,
  LearnerSnapshot,
  Lesson,
} from "../domain/types";
import { englishTranslator, useI18n, useT, type MessageKey, type Translate } from "../i18n";
import { Badge, Button, colors, Eyebrow, styles, Heading, textDirection, webDir } from "./ui";
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
export const roadmapLabel = (state: RoadmapState, t: Translate) =>
  t(`courseRoadmap.state.${state}` as MessageKey);
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
export function coverageText(coverage: PolicyCoverage, t: Translate = englishTranslator().t) {
  const extras = coverage.personalExtras.committed.count + coverage.personalExtras.reserved.count;
  return {
    core: t("courseRoadmap.coverage.core", {
      covered: coverage.coveredCoreObjectives,
      denominator: coverage.denominator,
    }),
    extras: extras ? t("courseRoadmap.coverage.extras", { count: extras }) : undefined,
  };
}
/**
 * Where the learner stands, for the next-step card: never "pick up where you left off" before
 * anything was started.
 * - `fresh`: nothing read, completed or placed yet;
 * - `resume`: the next lesson was started (a part read);
 * - `chapter`: the previous chapter is done and the next lesson opens a new one;
 * - `next`: the next lesson is not started yet;
 * - `waiting`: no lesson can be opened now (a checkpoint under review, for example);
 * - `finished`: every required lesson is complete or placed out;
 * - `paused` / `closed`: the enrollment's own state, from the server.
 */
export type NextStepState = "fresh" | "resume" | "chapter" | "next" | "waiting" | "finished" | "paused" | "closed";
export function nextStep(course: Course, snapshot: LearnerSnapshot, enrollmentStatus?: string) {
  const resume = resumeLesson(course, snapshot);
  const progressOf = (lesson: Lesson) => snapshot.lessons[lesson.id];
  const done = (lesson: Lesson) => ["completed", "placed"].includes(progressOf(lesson)?.status ?? "");
  const started = course.lessons.some((lesson) => done(lesson) || (progressOf(lesson)?.completedStepIds.length ?? 0) > 0);
  const section = resume && course.sections.find((row) => row.lessonIds.includes(resume.id));
  const sectionIndex = section ? course.sections.indexOf(section) : -1;
  const previous = sectionIndex > 0 ? course.sections[sectionIndex - 1] : undefined;
  const opensChapter = Boolean(
    section && previous && section.lessonIds[0] === resume?.id &&
      previous.lessonIds.every((id) => {
        const lesson = course.lessons.find((row) => row.id === id);
        return !lesson || lesson.requirement === "optional" || done(lesson);
      }),
  );
  const finished = !resume && course.lessons.filter((lesson) => lesson.requirement === "required").every(done);
  const state: NextStepState =
    enrollmentStatus === "closed" ? "closed"
      : enrollmentStatus === "paused" ? "paused"
        : finished ? "finished"
          : !resume ? "waiting"
            : !started ? "fresh"
              : (progressOf(resume)?.completedStepIds.length ?? 0) > 0 ? "resume"
                : opensChapter ? "chapter"
                  : "next";
  return { state, lesson: resume, section, sectionIndex };
}
const minutesOf = (course: Course, ids: readonly string[]) =>
  ids.reduce((sum, id) => sum + (course.lessons.find((lesson) => lesson.id === id)?.minutes ?? 0), 0);
/** A study time in the UI language: minutes under an hour and a half, else whole hours. */
export function durationText(minutes: number, t: Translate) {
  return minutes < 90
    ? t("courseRoadmap.duration.minutes", { count: minutes })
    : t("courseRoadmap.duration.hours", { count: Math.round(minutes / 60) });
}
/** A small padlock drawn with views: a glyph that reads the same on every platform and font. */
function LockGlyph({ color = colors.muted }: { color?: string }) {
  return (
    <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 12, height: 14, alignItems: "center" }}>
      <View style={{ width: 8, height: 7, borderWidth: 1.6, borderBottomWidth: 0, borderColor: color, borderTopLeftRadius: 4, borderTopRightRadius: 4 }} />
      <View style={{ width: 12, height: 8, backgroundColor: color, borderRadius: 2 }} />
    </View>
  );
}
/** A pressable row that shows hover and keyboard focus. */
function Row({ style, children, ...props }: Omit<LivePressableProps, "style" | "children"> & Record<`aria-${string}`, unknown> & {
  style: (active: boolean) => StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  return (
    <LivePressable
      {...(props as LivePressableProps)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={[style(hovered || focused), focused && { outlineColor: colors.ink, outlineStyle: "solid", outlineWidth: 2 } as ViewStyle]}
    >
      {children}
    </LivePressable>
  );
}
/** Text for assistive technology only (the visible cue is a shape, such as the padlock). */
function ScreenReaderOnly({ children }: { children: string }) {
  return <Text style={local.srOnly}>{children}</Text>;
}
/** A thin progress bar; its value is said in the text beside it. */
function ProgressBar({ value, total, tone = colors.teal }: { value: number; total: number; tone?: string }) {
  const share = total > 0 ? Math.min(1, value / total) : 0;
  return (
    <View aria-hidden style={local.track}>
      <View style={[local.fill, { width: `${share * 100}%`, backgroundColor: tone }]} />
    </View>
  );
}
export function CourseRoadmap({
  course,
  snapshot,
  compact,
  coverage,
  enrollmentStatus,
  onOpenLesson,
  onPlacement,
  children,
}: {
  /** Server coverage with a denominator fixed at enrollment. */
  coverage?: PolicyCoverage;
  course: Course;
  snapshot: LearnerSnapshot;
  compact: boolean;
  /** The enrollment's state on the server (active, paused, closed, …). */
  enrollmentStatus?: string;
  onOpenLesson: (lesson: Lesson) => void;
  onPlacement: () => void;
  /** Course panels (study dates, placement, review checks), shown between the next step and the path. */
  children?: React.ReactNode;
}) {
  const t = useT();
  // The closed chapter's chevron points along the reading direction.
  const rtl = useI18n().locale === "he";
  const next = nextStep(course, snapshot, enrollmentStatus);
  const resume = next.lesson;
  const total = course.lessons.length;
  const isDone = (id: string) => ["completed", "placed"].includes(snapshot.lessons[id]?.status ?? "");
  const doneCount = course.lessons.filter((lesson) => isDone(lesson.id)).length;
  const placed = course.lessons.filter((lesson) => snapshot.lessons[lesson.id]?.status === "placed").length;
  const totalMinutes = course.lessons.reduce((sum, lesson) => sum + lesson.minutes, 0);
  // Only the chapter the learner is in starts open (the first unfinished one when nothing can be
  // opened); the learner opens and closes the others.
  const initialOpen = next.section?.id ?? course.sections.find((section) => !section.lessonIds.every(isDone))?.id;
  const [open, setOpen] = useState<Record<string, boolean>>(() => (initialOpen ? { [initialOpen]: true } : {}));
  const baseId = useId();
  const number = (lesson: Lesson) => course.lessons.indexOf(lesson) + 1;
  const parts = resume ? resume.steps.length : 0;
  const partsRead = resume ? resume.steps.filter((step) => snapshot.lessons[resume.id]?.completedStepIds.includes(step.id)).length : 0;
  const requiredParts = resume ? resume.steps.filter((step) => step.requirement === "required").length : 0;
  const eyebrow = t(`courseRoadmap.next.${next.state}.eyebrow` as MessageKey);
  const action =
    !resume || next.state === "closed"
      ? undefined
      : next.state === "fresh"
        ? t("courseRoadmap.next.startCourse")
        : next.state === "resume"
          ? t("courseRoadmap.next.continueLesson", { number: number(resume) })
          : t("courseRoadmap.next.startLesson", { number: number(resume) });
  return (
    <View style={{ gap: compact ? 24 : 28 }} testID="course-roadmap">
      {/* Where am I: the course, then how far along. */}
      <View style={{ gap: 12 }}>
        {/* The course's own text in its own direction: the description starts where its title and
            subtitle do, in a Hebrew interface too. */}
        <View
          {...webDir(textDirection(course.title, course.subtitle, course.description))}
          style={{ gap: 10 }}
        >
          <Heading
            accessibilityRole="header"
            style={[local.hero, compact && local.heroCompact]}
          >
            {course.title}
          </Heading>
          {course.subtitle ? (
            <Text style={[styles.heading, { fontWeight: "400" }]}>
              {course.subtitle}
            </Text>
          ) : null}
          {course.description ? (
            <Text style={[styles.body, { maxWidth: 680 }]}>
              {course.description}
            </Text>
          ) : null}
        </View>
        <Text style={styles.small} testID="course-meta">
          {t("courseRoadmap.meta", {
            chapters: course.sections.length,
            lessons: total,
            duration: durationText(totalMinutes, t),
          })}
        </Text>
        <View style={{ gap: 6, maxWidth: 680 }} testID="course-progress">
          <ProgressBar value={doneCount} total={total} />
          <Text style={[styles.small, { color: colors.ink }]}>
            {placed
              ? t("courseRoadmap.progressPlaced", { completed: doneCount - placed, placed, total })
              : t("courseRoadmap.progress", { completed: doneCount, total })}
          </Text>
          {coverage && (
            <View style={{ gap: 2 }} testID="course-coverage">
              <Text style={styles.small}>{coverageText(coverage, t).core}</Text>
              {coverageText(coverage, t).extras && (
                <Text style={styles.small}>{coverageText(coverage, t).extras}</Text>
              )}
            </View>
          )}
        </View>
      </View>
      {/* What's next: one card, worded by where the learner really is. The lesson's time, parts and
          objective are here, never in a second card after the list. */}
      <View
        testID="next-step"
        role="region"
        aria-label={eyebrow}
        style={[local.next, compact && { padding: 20 }]}
      >
        <Eyebrow>{eyebrow}</Eyebrow>
        {resume && next.state !== "closed" && next.state !== "waiting" ? (
          <View style={{ gap: 8 }}>
            {/* The lesson's own text in its own direction, its lines starting where its title does. */}
            <View style={{ gap: 8 }} {...webDir(textDirection(resume.title, resume.description))}>
              <Heading accessibilityRole="header" aria-level={2} style={[styles.title, compact && { fontSize: 24, lineHeight: 30 }]}>
                {resume.title}
              </Heading>
              {resume.description ? (
                <Text style={[styles.body, { maxWidth: 640 }]}>{resume.description}</Text>
              ) : null}
            </View>
            <Text style={styles.small}>
              {t("courseRoadmap.next.meta", {
                number: number(resume),
                total,
                chapter: next.section?.title ?? "",
                minutes: resume.minutes,
                parts: requiredParts,
              })}
            </Text>
            {next.state === "resume" && parts > 0 && (
              <View style={{ gap: 6, maxWidth: 320 }}>
                <ProgressBar value={partsRead} total={parts} />
                <Text style={styles.small}>{t("courseRoadmap.next.partsRead", { read: partsRead, parts })}</Text>
              </View>
            )}
            {next.state === "paused" && <Text style={styles.small}>{t("courseRoadmap.next.paused.body")}</Text>}
          </View>
        ) : (
          <View style={{ gap: 6 }}>
            <Heading accessibilityRole="header" aria-level={2} style={[styles.title, compact && { fontSize: 24, lineHeight: 30 }]}>
              {t(`courseRoadmap.next.${next.state}.title` as MessageKey)}
            </Heading>
            <Text style={styles.body}>{t(`courseRoadmap.next.${next.state}.body` as MessageKey)}</Text>
          </View>
        )}
        {resume && action && (
          <Button
            label={action}
            kind="primary"
            usability="next"
            onPress={() => onOpenLesson(resume)}
            style={compact ? undefined : { alignSelf: "flex-start", paddingHorizontal: 24 }}
          />
        )}
      </View>
      {children}
      {course.placement && (
        <View style={[styles.card, { backgroundColor: colors.lilac, borderColor: colors.lilac }]}>
          <Badge label={t("courseRoadmap.placement.badge")} tone="lilac" />
          <Text accessibilityRole="header" style={styles.heading}>
            {course.placement.title}
          </Text>
          <Text style={styles.body}>{course.placement.description}</Text>
          <Button
            label={t("courseRoadmap.placement.explore")}
            onPress={onPlacement}
            style={{ alignSelf: "flex-start" }}
          />
        </View>
      )}
      {/* The path: chapters fold, the current one open; each says how far along it is. */}
      <View style={{ gap: 14 }}>
        <Text accessibilityRole="header" aria-level={2} style={styles.heading}>
          {t("courseRoadmap.path")}
        </Text>
        {stageGroups(course).map((group) => (
          <View key={group.stage?.id ?? "unstaged"} style={{ gap: 12 }}>
            {group.stage && (
              <View style={{ gap: 4, marginTop: 6 }}>
                <Heading role="heading" aria-level={3} style={[styles.heading, { fontSize: 17 }]}>
                  {group.stage.title}
                </Heading>
                {group.stage.summary ? <Text style={styles.small}>{group.stage.summary}</Text> : null}
              </View>
            )}
            {group.sections.map((section) => {
              const index = course.sections.indexOf(section);
              const lessons = section.lessonIds
                .map((id) => course.lessons.find((lesson) => lesson.id === id))
                .filter((lesson): lesson is Lesson => Boolean(lesson));
              const done = lessons.filter((lesson) => isDone(lesson.id)).length;
              const locked = lessons.every((lesson) => (snapshot.lessons[lesson.id]?.status ?? "locked") === "locked" && lesson.id !== resume?.id);
              const complete = lessons.length > 0 && done === lessons.length;
              const expanded = Boolean(open[section.id]);
              const panelId = `${baseId}-chapter-${index}`;
              const minutes = minutesOf(course, section.lessonIds);
              const summary = complete
                ? t("courseRoadmap.chapter.complete", { count: lessons.length, duration: durationText(minutes, t) })
                : locked
                  ? t("courseRoadmap.chapter.locked", { count: lessons.length, duration: durationText(minutes, t) })
                  : t("courseRoadmap.chapter.progress", { done, count: lessons.length, duration: durationText(minutes, t) });
              return (
                <View key={section.id} style={[local.chapter, section.id === next.section?.id && local.chapterCurrent]} testID="roadmap-chapter">
                  <Row
                    accessibilityRole="button"
                    aria-expanded={expanded}
                    {...(Platform.OS === "web" ? { "aria-controls": panelId } : {})}
                    accessibilityState={{ expanded }}
                    onPress={() => setOpen((all) => ({ ...all, [section.id]: !expanded }))}
                    style={(active) => [
                      local.chapterHead,
                      compact && { padding: 16, gap: 12 },
                      active && { backgroundColor: colors.paper },
                    ]}
                  >
                    <View style={[local.mark, complete && local.markDone, locked && local.markLocked]}>
                      {complete ? (
                        <Text aria-hidden style={[local.markText, { color: colors.teal }]}>✓</Text>
                      ) : locked ? (
                        <LockGlyph />
                      ) : (
                        <Text aria-hidden style={local.markText}>{index + 1}</Text>
                      )}
                    </View>
                    <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                      {section.subtitle ? <Eyebrow>{section.subtitle}</Eyebrow> : null}
                      <Text role="heading" aria-level={group.stage ? 4 : 3} style={[styles.heading, { fontSize: 17, lineHeight: 24 }, locked && { color: colors.muted }]}>
                        {section.title}
                      </Text>
                      <Text style={styles.small}>
                        {locked ? <ScreenReaderOnly>{`${t("courseRoadmap.state.locked")}: `}</ScreenReaderOnly> : null}
                        {summary}
                      </Text>
                      {!complete && !locked && done > 0 && (
                        <View style={{ maxWidth: 220, marginTop: 4 }}>
                          <ProgressBar value={done} total={lessons.length} />
                        </View>
                      )}
                    </View>
                    {section.iconAsset ? (
                      <Image source={{ uri: section.iconAsset }} accessible={false} aria-hidden style={local.chapterIcon} />
                    ) : null}
                    <Text aria-hidden style={[local.chevron, expanded && (rtl ? local.chevronOpenRtl : local.chevronOpen)]}>{rtl ? "‹" : "›"}</Text>
                  </Row>
                  <View
                    nativeID={panelId}
                    {...(Platform.OS === "web" ? { id: panelId } : {})}
                    style={expanded ? local.chapterBody : { display: "none" }}
                  >
                    {expanded && section.description ? (
                      <Text style={[styles.small, { paddingHorizontal: 4, paddingBottom: 8 }]}>{section.description}</Text>
                    ) : null}
                    <View role="list" aria-label={t("courseRoadmap.lessonsIn", { section: section.title })}>
                      {lessons.map((lesson) => (
                        <LessonRow
                          key={lesson.id}
                          lesson={lesson}
                          number={number(lesson)}
                          state={roadmapState(lesson, snapshot.lessons[lesson.id], resume?.id)}
                          progress={snapshot.lessons[lesson.id]}
                          compact={compact}
                          onOpen={() => onOpenLesson(lesson)}
                        />
                      ))}
                    </View>
                  </View>
                </View>
              );
            })}
          </View>
        ))}
      </View>
    </View>
  );
}
/**
 * One lesson of the path. A lesson that can be opened is a button that opens it; a locked one is
 * quiet: a padlock and its title, with "Locked" said to assistive technology only.
 */
function LessonRow({
  lesson,
  number,
  state,
  progress,
  compact,
  onOpen,
}: {
  lesson: Lesson;
  number: number;
  state: RoadmapState;
  progress: LearnerSnapshot["lessons"][string] | undefined;
  compact: boolean;
  onOpen: () => void;
}) {
  const t = useT();
  const locked = state === "locked";
  const current = state === "current";
  const read = lesson.steps.filter((step) => progress?.completedStepIds.includes(step.id)).length;
  const status = current
    ? read > 0
      ? t("courseRoadmap.row.inProgress", { read, parts: lesson.steps.length })
      : t("courseRoadmap.row.upNext")
    : state === "available" || state === "completed" || state === "locked"
      ? undefined
      : roadmapLabel(state, t);
  const mark = (
    <View style={[local.rowMark, current && local.rowMarkCurrent, (state === "completed" || state === "placed") && local.markDone]}>
      {locked ? (
        <LockGlyph />
      ) : state === "completed" ? (
        <Text aria-hidden style={[local.rowMarkText, { color: colors.teal }]}>✓</Text>
      ) : state === "placed" ? (
        <Text aria-hidden style={[local.rowMarkText, { color: colors.purple }]}>↗</Text>
      ) : (
        <Text aria-hidden style={[local.rowMarkText, current && { color: colors.white }]}>{number}</Text>
      )}
    </View>
  );
  const body = (
    <>
      {mark}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={[local.rowTitle, locked && { color: colors.muted, fontWeight: "500" }]} {...webDir(textDirection(lesson.title))}>
          {lesson.title}
          {locked ? <ScreenReaderOnly>{t("courseRoadmap.row.lockedSuffix")}</ScreenReaderOnly> : null}
        </Text>
        {status && <Text style={[styles.small, current && { color: colors.teal, fontWeight: "600" }]}>{status}</Text>}
        {lesson.personal && (
          <View style={{ alignSelf: "flex-start" }}>
            <Badge label={lesson.requirement === "optional" ? t("courseRoadmap.personalOptional") : t("courseRoadmap.personal")} tone="lilac" />
          </View>
        )}
      </View>
      {!compact || !locked ? (
        <Text style={[styles.small, local.rowMinutes]}>{t("courseRoadmap.row.minutes", { count: lesson.minutes })}</Text>
      ) : null}
    </>
  );
  const name = t("courseRoadmap.row.label", { number, lesson: lesson.title, state: roadmapLabel(state, t) });
  return (
    <View role="listitem">
      {locked ? (
        <View style={[local.row, compact && local.rowCompact]}>
          {body}
        </View>
      ) : (
        <Row
          accessibilityRole="button"
          accessibilityLabel={name}
          {...(Platform.OS === "web" && current ? { "aria-current": "step" as const } : {})}
          onPress={onOpen}
          style={(active) => [
            local.row,
            compact && local.rowCompact,
            current && local.rowCurrent,
            active && { backgroundColor: current ? "#D9F0E2" : colors.paper },
          ]}
        >
          {body}
        </Row>
      )}
    </View>
  );
}
const local = StyleSheet.create({
  hero: {
    fontSize: 36,
    lineHeight: 42,
    letterSpacing: -1,
    color: colors.ink,
    fontWeight: "700",
    maxWidth: 820,
  },
  heroCompact: { fontSize: 28, lineHeight: 34, letterSpacing: -0.6 },
  track: { height: 6, borderRadius: 3, backgroundColor: colors.line, overflow: "hidden" },
  fill: { height: 6, borderRadius: 3 },
  next: {
    backgroundColor: colors.mint,
    borderRadius: 18,
    padding: 24,
    gap: 14,
    borderWidth: 1,
    borderColor: "#CFE9DA",
  },
  chapter: {
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 16,
    overflow: "hidden",
  },
  chapterCurrent: { borderColor: "#9FD3BF" },
  chapterHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    padding: 18,
    minHeight: 48,
  },
  chapterBody: { paddingHorizontal: 10, paddingBottom: 10, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 8 },
  chapterIcon: { width: 36, height: 36, borderRadius: 10 },
  chevron: { fontSize: 24, lineHeight: 24, color: colors.muted, width: 20, textAlign: "center", transform: [{ rotate: "0deg" }] },
  chevronOpen: { transform: [{ rotate: "90deg" }] },
  chevronOpenRtl: { transform: [{ rotate: "-90deg" }] },
  mark: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1.5,
    borderColor: colors.line,
    backgroundColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
  },
  markDone: { backgroundColor: colors.mint, borderColor: colors.mint },
  markLocked: { backgroundColor: colors.paper, borderColor: colors.paper },
  markText: { fontSize: 14, fontWeight: "700", color: colors.ink },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 12,
    minHeight: 48,
  },
  rowCompact: { gap: 12, paddingHorizontal: 6 },
  rowCurrent: { backgroundColor: colors.mint },
  rowMark: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: colors.line,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.white,
  },
  rowMarkCurrent: { backgroundColor: colors.teal, borderColor: colors.teal },
  rowMarkText: { fontSize: 12, fontWeight: "700", color: colors.ink },
  rowTitle: { fontSize: 15, lineHeight: 22, fontWeight: "600", color: colors.ink },
  rowMinutes: { flexShrink: 0 },
  srOnly: { position: "absolute", width: 1, height: 1, overflow: "hidden", opacity: 0 },
});
