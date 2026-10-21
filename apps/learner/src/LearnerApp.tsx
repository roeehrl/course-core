import React, { useRef, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Companion } from "./components/Companion";
import { CourseRoadmap } from "./components/CourseRoadmap";
import { LessonFlow } from "./components/LessonFlow";
import { Overlay } from "./components/Overlay";
import { PlacementEntry } from "./components/PlacementEntry";
import { ProfileEditor } from "./components/ProfileEditor";
import { Badge, Button, colors, Notice, styles } from "./components/ui";
import {
  draftKey,
  effectiveLayout,
  firstOpenStep,
  safeRoute,
} from "./domain/session";
import type {
  Course,
  KeyValueStorage,
  LearnerClient,
  Lesson,
} from "./domain/types";
import { useLearner } from "./hooks/useLearner";
import { useApiErrorLocale } from "./client/apiClient";
import { useT, type MessageKey } from "./i18n";
import { useReadingFocus } from "./hooks/useReadingFocus";

export interface LearnerAppProps {
  course: Course;
  client: LearnerClient;
  storage: KeyValueStorage;
  /** Stable opaque account key supplied by the host; prevents draft crossover. */
  learnerKey: string;
  storageUnavailable?: boolean;
}
export function LearnerApp(props: LearnerAppProps) {
  useApiErrorLocale();
  return (
    <LearnerWorkspace
      key={JSON.stringify([
        props.learnerKey,
        props.course.id,
        props.course.version,
      ])}
      {...props}
    />
  );
}
function LearnerWorkspace({
  course,
  client,
  storage,
  learnerKey,
  storageUnavailable,
}: LearnerAppProps) {
  const t = useT();
  const learner = useLearner(course, client, storage, learnerKey);
  const {
    snapshot,
    session,
    setSession,
    navigate,
    pending,
    feedback,
    error,
    run,
  } = learner;
  const dimensions = useWindowDimensions();
  const [containerWidth, setContainerWidth] = useState(dimensions.width);
  const layout = effectiveLayout(
    Math.min(dimensions.width, containerWidth),
    dimensions.height,
    dimensions.fontScale,
  );
  const [dialog, setDialog] = useState<"profile" | "placement" | "companion">();
  const scroll = useRef<ScrollView>(null);
  const content = useRef<View>(null);
  const route = session.route;
  const lesson =
    route.screen === "lesson"
      ? course.lessons.find((item) => item.id === route.lessonId)
      : undefined;
  const step =
    route.screen === "lesson"
      ? lesson?.steps.find((item) => item.id === route.stepId)
      : undefined;
  const stepKey = lesson && step ? draftKey(lesson.id, step.id) : "roadmap";
  useReadingFocus(`${!!snapshot}:${stepKey}`, scroll, content);
  const noteKey = stepKey;
  function openDialog(value: typeof dialog) {
    learner.clearFeedback();
    setDialog(value);
  }
  function closeDialog() {
    if (!pending) {
      setDialog(undefined);
      learner.clearFeedback();
    }
  }
  function openLesson(item: Lesson) {
    if (snapshot)
      navigate({
        screen: "lesson",
        lessonId: item.id,
        stepId: firstOpenStep(item, snapshot),
      });
  }
  function nextStep() {
    if (!lesson || !step) return;
    const next = lesson.steps[lesson.steps.indexOf(step) + 1];
    navigate(
      next
        ? { screen: "lesson", lessonId: lesson.id, stepId: next.id }
        : { screen: "roadmap" },
    );
  }
  const companion = (
    <Companion
      key={stepKey}
      step={step}
      lessonTitle={lesson?.title}
      note={session.notes[noteKey] ?? ""}
      onNoteChange={(value) =>
        setSession((current) => ({
          ...current,
          notes: { ...current.notes, [noteKey]: value },
        }))
      }
      mode={snapshot?.mode ?? "demo"}
    />
  );
  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.paper }}
      onLayout={(event) => setContainerWidth(event.nativeEvent.layout.width)}
    >
      <ScrollView
        ref={scroll}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ flexGrow: 1 }}
      >
        <View
          style={{
            backgroundColor: colors.white,
            borderBottomWidth: 1,
            borderColor: colors.line,
          }}
        >
          <View
            style={[
              styles.spread,
              {
                width: "100%",
                maxWidth: 1280,
                alignSelf: "center",
                paddingHorizontal: layout.compact ? 20 : 40,
                paddingVertical: 18,
              },
            ]}
          >
            <View style={styles.row}>
              <View
                style={{
                  width: 35,
                  height: 35,
                  borderRadius: 10,
                  backgroundColor: colors.teal,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text
                  style={{
                    color: colors.white,
                    fontSize: 23,
                    fontWeight: "700",
                  }}
                >
                  {/* i18n-ignore: logo letter of the product name, not translated */}
                  c
                </Text>
              </View>
              {/* The product name stays Latin and left to right in every locale. */}
              <Text
                style={{
                  color: colors.ink,
                  fontSize: 21,
                  letterSpacing: -0.8,
                  fontWeight: "700",
                  writingDirection: "ltr",
                }}
              >
                {/* i18n-ignore: product name wordmark, not translated */}
                course<Text style={{ color: colors.teal }}>{/* i18n-ignore: product name wordmark */}core</Text>
              </Text>
            </View>
            <View style={[styles.row, { gap: 6 }]}>
              {snapshot && (
                <>
                  <Button
                    label={t("learnerApp.nav.path")}
                    kind="quiet"
                    onPress={() => navigate({ screen: "roadmap" })}
                    disabled={pending}
                  />
                  {!layout.companionPane && (
                    <Button
                      label={t("learnerApp.nav.companion")}
                      kind="quiet"
                      onPress={() => openDialog("companion")}
                      disabled={pending}
                    />
                  )}
                  <Button
                    label={t("learnerApp.nav.profile")}
                    onPress={() => openDialog("profile")}
                    disabled={pending}
                  />
                </>
              )}
            </View>
          </View>
        </View>
        {!snapshot ? (
          <View style={{ padding: 40, gap: 20 }}>
            {error ? (
              <>
                <Notice error>{error}</Notice>
                <Button label={t("learnerApp.retryLoad")} onPress={learner.reload} />
              </>
            ) : (
              <>
                <ActivityIndicator color={colors.teal} />
                <Text accessibilityLiveRegion="polite" style={styles.body}>
                  {t("learnerApp.loading")}
                </Text>
              </>
            )}
          </View>
        ) : (
          <View
            style={{
              width: "100%",
              maxWidth: 1280,
              alignSelf: "center",
              paddingHorizontal: layout.compact ? 20 : 40,
              paddingTop: layout.compact ? 24 : 34,
              paddingBottom: 32,
              gap: 24,
            }}
          >
            <View style={styles.spread}>
              <Text style={styles.small}>
                {session.route.screen === "roadmap"
                  ? t("learnerApp.eyebrow.journey")
                  : t("learnerApp.eyebrow.lesson")}
              </Text>
              <Badge
                label={
                  snapshot.mode === "demo"
                    ? t("learnerApp.badge.demo")
                    : t("learnerApp.badge.connected")
                }
                tone="neutral"
              />
            </View>
            {storageUnavailable && (
              <Notice error>
                {t("learnerApp.storageUnavailable")}
              </Notice>
            )}
            {error && !dialog && (
              <View style={{ gap: 8 }}>
                <Notice error>{error}</Notice>
                <Button
                  label={t("learnerApp.reloadProgress")}
                  kind="quiet"
                  onPress={learner.reload}
                  disabled={pending}
                />
              </View>
            )}
            <View
              style={{
                flexDirection: layout.companionPane ? "row" : "column",
                gap: 40,
                alignItems: "flex-start",
              }}
            >
              <View
                ref={content}
                nativeID="learning-content"
                style={{ flex: 1, width: "100%", minWidth: 0 }}
              >
                {lesson && step ? (
                  <LessonFlow
                    lesson={lesson}
                    step={step}
                    snapshot={snapshot}
                    compact={layout.compact}
                    answer={session.drafts[stepKey] ?? ""}
                    feedback={feedback}
                    pending={pending}
                    onAnswer={(value) => {
                      learner.clearFeedback();
                      setSession((current) => ({
                        ...current,
                        drafts: { ...current.drafts, [stepKey]: value },
                      }));
                    }}
                    onStep={(stepId) =>
                      navigate({
                        screen: "lesson",
                        lessonId: lesson.id,
                        stepId,
                      })
                    }
                    onContinue={nextStep}
                    onBack={() => navigate({ screen: "roadmap" })}
                    onSubmit={async () => {
                      const answer = session.drafts[stepKey];
                      const result = await run(
                        JSON.stringify(["step", lesson.id, step.id, answer]),
                        (context) =>
                          client.submitStep({
                            ...context,
                            lessonId: lesson.id,
                            stepId: step.id,
                            answer,
                          }),
                      );
                      if (
                        result?.feedback.outcome === "accepted" &&
                        step.kind === "reading"
                      ) {
                        const next =
                          lesson.steps[lesson.steps.indexOf(step) + 1];
                        learner.clearFeedback();
                        // The returned snapshot has acknowledged this step; avoid the old render's gate state.
                        setSession((current) => ({
                          ...current,
                          route: safeRoute(
                            course,
                            result.snapshot,
                            next
                              ? {
                                  screen: "lesson",
                                  lessonId: lesson.id,
                                  stepId: next.id,
                                }
                              : { screen: "roadmap" },
                          ),
                        }));
                      }
                    }}
                  />
                ) : (
                  <CourseRoadmap
                    course={course}
                    snapshot={snapshot}
                    compact={layout.compact}
                    onOpenLesson={openLesson}
                    onPlacement={() => openDialog("placement")}
                  />
                )}
              </View>
              {layout.companionPane && (
                <View
                  testID="companion-pane"
                  style={{
                    width: 288,
                    padding: 22,
                    gap: 20,
                    backgroundColor: colors.white,
                    borderWidth: 1,
                    borderColor: colors.line,
                    borderRadius: 20,
                  }}
                >
                  {companion}
                </View>
              )}
            </View>
            <View
              style={[
                styles.spread,
                {
                  borderTopWidth: 1,
                  borderColor: colors.line,
                  paddingTop: 20,
                  marginTop: 8,
                },
              ]}
            >
              <Text style={styles.small}>
                {snapshot.mode === "demo"
                  ? t("learnerApp.footer.demo")
                  : t("learnerApp.footer.connected")}
              </Text>
              <Text style={styles.small}>
                {t("learnerApp.footer.tagline")}
              </Text>
            </View>
          </View>
        )}
      </ScrollView>
      {dialog && snapshot && (
        <Overlay title={t(`learnerApp.dialog.${dialog}` as MessageKey)} onClose={closeDialog}>
          {dialog === "companion" ? (
            <View style={{ paddingTop: 24 }}>{companion}</View>
          ) : dialog === "profile" ? (
            <ProfileEditor
              profile={snapshot.profile}
              pending={pending}
              error={error}
              saved={feedback?.outcome === "accepted"}
              demo={snapshot.mode === "demo"}
              onSave={(profile) => {
                void run(JSON.stringify(["profile", profile]), (context) =>
                  client.saveProfile({ ...context, profile }),
                );
              }}
            />
          ) : (
            course.placement && (
              <PlacementEntry
                placement={course.placement}
                pending={pending}
                feedback={feedback}
                error={error}
                demo={snapshot.mode === "demo"}
                onClose={closeDialog}
                onSubmit={(answer) => {
                  void run(JSON.stringify(["placement", answer]), (context) =>
                    client.requestPlacement({ ...context, answer }),
                  );
                }}
              />
            )
          )}
        </Overlay>
      )}
    </SafeAreaView>
  );
}
