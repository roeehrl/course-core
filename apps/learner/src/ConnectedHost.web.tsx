import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ActivityIndicator,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import {
  apiErrorMessage,
  createCourseApi,
  CourseApiError,
  useApiErrorLocale,
  type Challenge,
  type ServerSnapshot,
} from "./client/apiClient";
import {
  createCompanionClient,
  type CompanionContext,
  type CompanionReceipt,
  type ContextualCompanionClient,
} from "./client/companionClient";
import { PLACEMENT_PANEL_ID, presentation } from "./client/presentation";
import { CourseRoadmap, coverageText } from "./components/CourseRoadmap";
import { FirstLoadProvider, useFirstLoad } from "./connected/firstLoad";
import { classifyClick, createUsabilityRecorder } from "./connected/usability";
import { ProfileEditor } from "./components/ProfileEditor";
import { LocaleSwitcher } from "./components/LocaleSwitcher";
import { englishTranslator, useI18n, useT, type MessageKey, type Translate } from "./i18n";
import { useLocaleControl } from "./i18n/LocaleProvider";
import { fetchServerLocale, saveServerLocale } from "./i18n/localeApi";
import { isSupportedLocale, type AppLocale } from "@course-core/i18n";
import { LearnerMemoryPanel } from './components/LearnerMemoryPanel';
import { createMemoryClient } from './client/memoryClient';
import { createHypothesisClient } from './client/hypothesisClient';
import { TeachingHypothesesPanel } from './components/TeachingHypothesesPanel';
import { createSupervisionClient } from './client/supervisionClient';
import { createInspectorClient, type InspectorAccess } from './client/inspectorClient';
import { DebugInspector } from './connected/DebugInspector.web';
import { createResourcesClient } from './client/resourcesClient';
import { createActivityClient } from './client/activityClient';
import { YourDataPanel } from './components/YourDataPanel';
import { ConnectedAgentsPanel } from './components/ConnectedAgentsPanel';
import { CrossCoursePanel } from './components/CrossCoursePanel';
import { PlacementRun } from './components/PlacementRun';
import { RetentionPanel } from './components/RetentionPanel';
import { PersonalChanges } from './components/PersonalChanges';
import { ReviewAssistConsent } from './components/ReviewAssistConsent';
import { StudyConsent } from './components/StudyConsent';
import type { WrittenReview } from './components/ReviewStatus';
import { SupervisionPanel } from './components/SupervisionPanel';
import { SupervisorRequests } from './components/SupervisorRequests';
import { CompanionDock } from "./components/CompanionDock";
import { ConnectedCompanion } from "./components/ConnectedCompanion";
import { Badge, Button, Notice, styles } from "./components/ui";
import { ConnectedLesson } from "./connected/ConnectedLesson.web";
import type { VisualCompletionReport, VisualContextChange, VisualInteractionContext } from './components/VisualBlock';
import {
  createConnectedDraftStore,
  type BrowserStore,
} from "./connected/drafts";
import { mediaUrlExpiry } from "./connected/resources";
import { useKeyboardInset, useLayoutViewport } from "./connected/layoutViewport";
import { ConnectionStatus, DraftConflict, useOnline, usePageReturn, useSlow } from "./connected/connectivity.web";
import { useUnverifiedContent } from "./connected/unverified.web";
import { keepLessonPlace, PendingChangesNotice, usePendingChanges } from "./connected/pendingChanges.web";
import type { PresenceKind, PresenceState } from "./connected/presence.web";
import { useGeneratedComponents } from "./connected/GeneratedComponent.web";
import { YourCourseMenu } from "./connected/YourCourseMenu.web";
import { companionPlacement, windowClass, type WindowClass } from "./domain/windowClass";
import { platformCapabilities, pointerMedia } from "./client/platformCapabilities";
import { useCompanionConversation } from "./hooks/useCompanionConversation";
import type { Profile } from "./domain/types";
import { courseContentAttributes } from "./domain/contentLanguage";
import "./connected/connected.css";
import { codeSubmissionError } from "./connected/code";
import { answerFeedback } from "./connected/answerFeedback";
import { answerPayload } from "./connected/AssessmentInput.web";
import type { NextAction } from "@course-core/sdk";
import {
  createPolicyClient,
  type CatalogCourse,
  type Enrollment,
  type ExtensionOffer,
} from "./client/policyClient";
import { useEnrollmentPolicy } from "./hooks/useEnrollmentPolicy";
import { EnrollmentPreview } from "./components/EnrollmentPreview";
import { PolicyPanel } from "./components/PolicyPanel.web";
import { ClosureSummary } from "./components/ClosureSummary";
import { CourseVersionNotice } from "./components/CourseVersionNotice.web";
import { CourseVersionOffer } from "./components/CourseVersionOffer.web";
import { ContinuationTrack } from "./components/ContinuationTrack";
import { ChangePassword, PasswordSignIn } from "./connected/PasswordForms.web";
import { PasskeyManager, PasskeySignIn, passkeysSupported } from "./connected/Passkeys.web";

interface Account {
  id: string;
  displayName: string;
  loginName?: string | null;
  hasPassword?: boolean;
}
export interface ConnectedHostProps {
  companionClient?: ContextualCompanionClient;
}
/** What the companion says about a closed course's read-only question allowance. */
export function closedHelpText(
  allowance: { budget?: number; used?: number; remaining: number },
  exhausted: boolean,
  t: Translate = englishTranslator().t,
) {
  if (exhausted) return t("connectedHost.closedHelp.exhausted");
  return allowance.used !== undefined && allowance.budget !== undefined
    ? t("connectedHost.closedHelp.remainingOfBudget", {
        remaining: allowance.remaining,
        used: allowance.used,
        budget: allowance.budget,
      })
    : t("connectedHost.closedHelp.remaining", { remaining: allowance.remaining });
}
/** Learning-record event types with their own label (`connectedHost.record.event.<type with _>`). */
const RECORD_EVENTS = new Set([
  "block.read",
  "assessment.answered",
  "assessment.submitted",
  "assessment.issued",
  "episode.placed",
  "episode.completed",
  "companion.requested",
  "profile.updated",
  "visual.completed",
  "course_version.moved",
  "course_version.move_undone",
  "course_version.move_offered",
  "course_version.move_offer_accepted",
  "course_version.move_offer_declined",
  "course_version.move_forced",
]);
const PANE_PREFERENCE = "course:learner-companion-pane";
/** The learner's last explicit choice to show or hide the companion pane. A
 * device preference only; it never affects progress. */
function readPanePreference(): "open" | "collapsed" | undefined {
  try {
    const value = window.localStorage.getItem(PANE_PREFERENCE);
    return value === "open" || value === "collapsed" ? value : undefined;
  } catch {
    return;
  }
}
function writePanePreference(value: "open" | "collapsed") {
  try {
    window.localStorage.setItem(PANE_PREFERENCE, value);
  } catch {
    /* The choice then lasts for this page only. */
  }
}
/** Drafts and saved-but-unconfirmed requests live in local storage, so they
 * survive a closed tab, a crash or a phone discarding the page. Keys are
 * account-scoped and signing out clears the drafts. */
function browserStore(): BrowserStore | undefined {
  for (const pick of [() => window.localStorage, () => window.sessionStorage])
    try {
      const store = pick();
      if (store) return store;
    } catch {
      /* try the next one */
    }
  return;
}
/** Panels above the roadmap that must finish their first read before the course page shows. */
const COURSE_PAGE_PANELS = ["study", "policy", "placement", "retention"] as const;

export function ConnectedHost({ companionClient }: ConnectedHostProps = {}) {
  const t = useT();
  const i18n = useI18n();
  // CourseApiError.message, read by the panels, follows the UI locale.
  useApiErrorLocale();
  /** An enrollment state in the UI language; an unknown state shows its code. */
  const enrollmentStatus = (status: string) => {
    const key = `connectedHost.enrollmentStatus.${status}` as MessageKey;
    return i18n.has(key) ? t(key) : status;
  };
  const localeControl = useLocaleControl();
  const [initialApi] = useState(() => createCourseApi());
  // Layout follows the layout viewport, not the visual viewport, so an on-screen
  // keyboard cannot flip the wide layout to compact while the learner types.
  const { fontScale } = useWindowDimensions(),
    { width, height } = useLayoutViewport(),
    size: WindowClass = windowClass(width, fontScale),
    compact = size === "compact",
    wide = companionPlacement(size, height) === "pane";
  // Beside the lesson the pane starts open in expanded windows and collapsed in
  // medium ones (where the lesson needs the width) until the learner chooses.
  // The default is taken from the window the page opened in, so a later resize
  // never hides a pane the learner may be typing in.
  const [panePreference, setPanePreference] = useState(
    () => readPanePreference() ?? (size === "expanded" ? "open" : "collapsed"),
  );
  const paneCollapsed = panePreference === "collapsed";
  const setPaneCollapsed = useCallback((value: boolean) => {
    const next = value ? "collapsed" : "open";
    setPanePreference(next);
    writePanePreference(next);
  }, []);
  const paneShown = wide && !paneCollapsed;
  const hostRef = useRef<HTMLDivElement>(null);
  // In the compact layout the lesson scrolls in its own pane; otherwise in the window.
  useKeyboardInset(hostRef, () => (wide ? null : document.querySelector(".connected-main")));
  const [account, setAccount] = useState<Account>(),
    [ready, setReady] = useState(false),
    [loginCodes, setLoginCodes] = useState(false),
    [changingPassword, setChangingPassword] = useState(false),
    [passkeys, setPasskeys] = useState(false),
    [managingPasskeys, setManagingPasskeys] = useState(false);
  const [pending, setPending] = useState(false),
    busy = useRef(false),
    [error, setError] = useState(""),
    // A notice is rendered at display time, so it follows a language switch while it shows.
    [notice, setNotice] = useState<{ render: (t: Translate) => string } | null>(null);
  const slowRequest = useSlow(pending);
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]),
    [catalog, setCatalog] = useState<CatalogCourse[]>([]);
  const [preview, setPreview] = useState<CatalogCourse>();
  const [startAttempts, setStartAttempts] = useState<Record<string, boolean>>(
    {},
  );
  const [server, setServer] = useState<ServerSnapshot>(),
    [episodeId, setEpisodeId] = useState<string>(),
    [placement, setPlacement] = useState(false),
    [placementOpen, setPlacementOpen] = useState(false);
  const [view, setView] = useState<"learn" | "profile" | "activity">("learn"),
    [companionOpen, setCompanionOpen] = useState(false);
  const [events, setEvents] = useState<
    { id: string; event_type: string; created_at: string }[]
  >([]);
  const [storageUnavailable, setStorageUnavailable] = useState(false),
    [now, setNow] = useState(Date.now());
  const [checkingAnswer, setCheckingAnswer] = useState(false);
  // An answer (or "I don't know yet") is being saved: only then are the check's options locked.
  // Any other request in flight (a companion message, marking a part read) leaves them usable,
  // so a tap on an option always chooses it.
  const [savingAnswer, setSavingAnswer] = useState(false);
  /** Optional confidence per open check. Never sent unless the learner chose a level. */
  const [confidence, setConfidence] = useState<Record<string, number | null>>({});
  const [block, setBlock] = useState<{
    scope?: string;
    id?: string;
    title?: string;
  }>({});
  const store = useMemo(browserStore, [account?.id]);
  const api = useMemo(
    () =>
      createCourseApi({
        accountId: account?.id,
        pending: store,
        onStorageUnavailable: () => setStorageUnavailable(true),
      }),
    [account?.id, store],
  );
  const drafts = useMemo(
    () => createConnectedDraftStore(account?.id ?? "signed-out", store),
    [account?.id, store],
  );
  useSyncExternalStore(
    drafts.subscribe,
    drafts.getSnapshot,
    drafts.getSnapshot,
  );
  const chat = useMemo(
    () => companionClient ?? createCompanionClient(api),
    [companionClient, api],
  );
  // The conversation lives in <LiveConversation> inside the dock, so a new message re-renders
  // the companion only, not the lesson and the panels beside it. The page needs one number from it.
  const [unansweredQuestions, setUnansweredQuestions] = useState(0);
  // Leaving the page ends the study session on the server (trigger T10 "session ended"). A page
  // kept in the back/forward cache counts as left too; any later learner event starts a new one.
  const sessionEnrollment = server?.enrollmentId;
  useEffect(() => {
    if (!sessionEnrollment || typeof window === "undefined") return;
    const left = () => void api.notify(`/api/enrollments/${encodeURIComponent(sessionEnrollment)}/session/end`);
    window.addEventListener("pagehide", left);
    return () => window.removeEventListener("pagehide", left);
  }, [api, sessionEnrollment]);
  const policyClient = useMemo(() => createPolicyClient(api), [api]);
  const memoryClient = useMemo(() => createMemoryClient(api, account?.id ?? 'signed-out'), [api, account?.id]);
  const hypothesisClient = useMemo(() => createHypothesisClient(api, account?.id ?? 'signed-out'), [api, account?.id]);
  const supervisionClient = useMemo(() => createSupervisionClient(api), [api]);
  const inspectorClient = useMemo(() => createInspectorClient(api), [api]);
  // Whether this account may open the debug inspector here: owners and admins only, decided by the server.
  const [inspectorAccess, setInspectorAccess] = useState<{ enrollmentId: string; access: InspectorAccess }>();
  useEffect(() => {
    const enrollmentId = server?.enrollmentId;
    if (!enrollmentId) return;
    const controller = new AbortController();
    inspectorClient.access(enrollmentId, controller.signal).then(
      (access) => !controller.signal.aborted && setInspectorAccess({ enrollmentId, access }),
      () => !controller.signal.aborted && setInspectorAccess({ enrollmentId, access: { available: false } }),
    );
    return () => controller.abort();
  }, [inspectorClient, server?.enrollmentId]);
  const resourcesClient = useMemo(() => createResourcesClient(api), [api]);
  const activityClient = useMemo(() => createActivityClient(api), [api]);
  const reviewsLoader = useMemo(() => async (enrollmentId: string, signal: AbortSignal) =>
    (await api.request<{ reviews: WrittenReview[] }>(`/api/enrollments/${encodeURIComponent(enrollmentId)}/reviews`, "GET", undefined, { signal })).reviews, [api]);
  const [questionsExhausted, setQuestionsExhausted] = useState<{ budget?: number }>();
  const policy = useEnrollmentPolicy(
    policyClient,
    server?.enrollmentId,
    server?.revision ?? 0,
  );
  // The course page appears once its panels have read their state (connected/firstLoad.ts).
  const { settled: coursePageSettled, report: reportFirstLoad } = useFirstLoad(server?.enrollmentId, COURSE_PAGE_PANELS);
  useEffect(() => {
    if (server && !policy.loading) reportFirstLoad("policy");
  }, [server, policy.loading, reportFirstLoad]);
  const model = useMemo(
    () => (server ? presentation(server, { placementOpen, t }) : undefined),
    [server, placementOpen, t],
  );
  const episode = server?.course.chapters
    .flatMap((chapter) => chapter.episodes)
    .find((row) => row.id === episodeId);
  const challenge = server?.activeChallenges.find(
    (row) => row.episodeId === episodeId,
  );
  // Usability timings, only while the learner takes part in a study that asked for them
  // (connected/usability.ts). The server refuses them otherwise, and recording then stops.
  const measuring = server?.studyArm?.measuresUsability === true ? server.enrollmentId : undefined;
  const sizeNow = useRef(size);
  sizeNow.current = size;
  const usability = useMemo(() => {
    if (!measuring) return null;
    const path = `/api/enrollments/${encodeURIComponent(measuring)}/study/usability`;
    return createUsabilityRecorder({
      deviceClass: () => (sizeNow.current === "compact" ? "phone" : sizeNow.current === "medium" ? "tablet" : "desktop"),
      send: async (batchId, trials) => {
        try {
          await api.request(path, "POST", { batchId, trials });
          return "ok";
        } catch (cause) {
          if (cause instanceof CourseApiError && ["STUDY_USABILITY_OFF", "ENROLLMENT_NOT_FOUND", "INVALID_REQUEST"].includes(cause.code)) return "off";
          throw cause;
        }
      },
    });
  }, [api, measuring]);
  useEffect(() => {
    if (!usability) return;
    const onClick = (event: MouseEvent) => {
      const kind = classifyClick(event.target instanceof Element ? event.target : null);
      if (kind) usability.action(kind);
    };
    const onVisibility = () => (document.visibilityState === "hidden" ? void usability.hidden() : usability.visible());
    document.addEventListener("click", onClick, true);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("visibilitychange", onVisibility);
      void usability.hidden();
    };
  }, [usability]);
  const challengeId = challenge?.challengeId;
  useEffect(() => {
    if (!usability || view !== "learn" || !server) return;
    if (!episodeId) {
      if (coursePageSettled) usability.shown("course_page", "course");
    } else usability.shown(challengeId ? "check" : "lesson", episodeId);
  }, [usability, view, server, episodeId, challengeId, coursePageSettled]);
  const scope = JSON.stringify([server?.enrollmentId, server?.courseDigest]);
  const readingScope = `${scope}:episode:${episodeId ?? "none"}`;
  const activeReadingScope = useRef(readingScope);
  activeReadingScope.current = readingScope;
  const visualFrame = useRef<{ scope: string; context: VisualInteractionContext } | null>(null);
  // Keep only the latest frame locally. Animation ticks must neither rerender
  // the whole lesson nor create network requests/history entries.
  const onVisualContextChange = useCallback((change: VisualContextChange) => {
    if (activeReadingScope.current !== readingScope) return;
    if (change.kind === 'frame') visualFrame.current = { scope: readingScope, context: change.context };
    else if (visualFrame.current?.scope === readingScope && (!change.source ||
      (visualFrame.current.context.blockId === change.source.blockId && visualFrame.current.context.visualId === change.source.visualId))) visualFrame.current = null;
  }, [readingScope]);
  // A visual's completion is an observation (visual-observations.ts on the server): sent once
  // per block view, recorded at most once per course version, and never progress or evidence.
  // Best effort: a failed send is not retried and shows nothing.
  const enrollmentIdForVisuals = server?.enrollmentId;
  const onVisualComplete = useCallback((completion: VisualCompletionReport) => {
    if (!enrollmentIdForVisuals) return;
    api
      .request(`/api/enrollments/${encodeURIComponent(enrollmentIdForVisuals)}/visual-completions`, "POST", completion)
      .catch(() => undefined);
  }, [api, enrollmentIdForVisuals]);
  // When the learner starts or stops using an interactive part of the lesson (E03): a personal
  // change to that lesson waits while they are in it. Best effort, like visual completions; a
  // report sent while the page unloads uses keepalive.
  // Once signing out has begun, the lesson's parts closing as it unmounts report nothing: the
  // session is gone, and the server lets an open report lapse on its own.
  const signingOut = useRef(false);
  useEffect(() => {
    if (account) signingOut.current = false;
  }, [account]);
  const onPresence = useCallback((presenceEpisodeId: string, blockId: string, kind: PresenceKind, state: PresenceState, leaving?: boolean) => {
    if (!enrollmentIdForVisuals || signingOut.current) return;
    api
      .request(`/api/enrollments/${encodeURIComponent(enrollmentIdForVisuals)}/presence`, "POST", { episodeId: presenceEpisodeId, blockId, kind, state },
        leaving ? { keepalive: true } : {})
      .catch(() => undefined);
  }, [api, enrollmentIdForVisuals]);
  // What this app can do (platform capabilities, M02): reported once per distinct report per
  // page, best effort. A description of the device for staff and debugging, never a permission.
  const reportedPlatforms = useRef(new Set<string>());
  const platformReport = enrollmentIdForVisuals ? platformCapabilities(width, size, pointerMedia()) : undefined;
  const platformKey = platformReport && `${enrollmentIdForVisuals}:${platformReport.target}:${platformReport.layoutClass}:${platformReport.inputModes.join(",")}`;
  useEffect(() => {
    if (!platformReport || !platformKey || reportedPlatforms.current.has(platformKey)) return;
    reportedPlatforms.current.add(platformKey);
    api
      .request(`/api/enrollments/${encodeURIComponent(enrollmentIdForVisuals!)}/platform-capabilities`, "POST", platformReport)
      .catch(() => undefined);
    // platformKey covers every field of the report that can change.
  }, [api, platformKey]);
  const codeQuestion = challenge?.question.type === "code" || challenge?.question.type === "code_repair" ? challenge.question : undefined;
  const answerKey = `${scope}:${codeQuestion ? "code-answer" : "answer"}:${challenge?.challengeId ?? "none"}`,
    draftKey = `${scope}:companion:${episodeId ?? "roadmap"}`;
  const answer = drafts.has(answerKey)
      ? drafts.read(answerKey)
      : codeQuestion
        ? codeQuestion.starterCode
        : "",
    draft = drafts.read(draftKey);
  // A closed (completed or capped) course keeps a bounded number of read-only questions.
  const closedAllowance: { budget?: number; used?: number; remaining: number } | undefined =
    policy.data?.closedQuestions ?? (questionsExhausted ? { ...questionsExhausted, remaining: 0 } : undefined);
  const helpExhausted = Boolean(questionsExhausted) || closedAllowance?.remaining === 0;
  useEffect(() => setQuestionsExhausted(undefined), [server?.enrollmentId]);
  // A refused or unanswered question is not charged: when one settles that way, the closed-course
  // allowance it held is returned, so read the allowance again instead of keeping a stale refusal.
  const reloadPolicy = policy.reload;
  useEffect(() => {
    if (!unansweredQuestions) return;
    setQuestionsExhausted(undefined);
    reloadPolicy();
  }, [unansweredQuestions, reloadPolicy]);
  const unverified = useUnverifiedContent(api, server?.enrollmentId, server?.revision ?? 0);
  const pendingAdditions = usePendingChanges(api, server?.enrollmentId, server?.revision ?? 0);
  const components = useGeneratedComponents(api, server?.enrollmentId, server?.revision ?? 0);
  /** Opens "Your personal changes" at the change that added generated content. */
  function reviewChange(proposalId: string) {
    setView("profile");
    let tries = 0;
    const show = () => {
      const target = document.getElementById(`personal-change-${proposalId}`);
      if (target) {
        target.scrollIntoView({ block: "start" });
        target.focus({ preventScroll: true });
      } else if (++tries < 40) setTimeout(show, 50);
    };
    setTimeout(show, 0);
  }
  const answerConflict = drafts.conflict(answerKey),
    companionConflict = drafts.conflict(draftKey);
  const titles = useMemo(
    () =>
      Object.fromEntries(
        server?.course.chapters.flatMap((chapter) =>
          chapter.episodes.map((row) => [row.id, row.title]),
        ) ?? [],
      ),
    [server?.course],
  );
  const context: CompanionContext = {
    enrollmentId: server?.enrollmentId ?? "",
    courseDigest: server?.courseDigest ?? "",
    snapshotRevision: server?.revision ?? 0,
    courseTitle: server?.course.title ?? "",
    episodeId: episode?.id,
    episodeTitle: episode?.title,
    blockId: block.scope === readingScope ? block.id : undefined,
    blockTitle: block.scope === readingScope ? block.title : undefined,
    independentChallengeIds:
      server?.activeChallenges
        .filter(
          (item) =>
            item.independentEligible &&
            (!item.expiresAt ||
              !Number.isFinite(Date.parse(item.expiresAt)) ||
              Date.parse(item.expiresAt) > now),
        )
        .map((item) => item.challengeId) ?? [],
  };
  const onBlockChange = useCallback(
    (id: string | undefined, title: string | undefined) =>
      setBlock((current) =>
        current.scope === readingScope &&
        current.id === id &&
        current.title === title
          ? current
          : { scope: readingScope, id, title },
      ),
    [readingScope],
  );
  useEffect(() => {
    const deadlines = [
      ...(server?.activeChallenges.map((item) =>
        Date.parse(item.expiresAt ?? ""),
      ) ?? []),
      ...(server?.course.media.map((media) => mediaUrlExpiry(media.url)) ?? []),
    ].filter(
      (value): value is number =>
        value !== undefined && Number.isFinite(value) && value > Date.now(),
    );
    if (!deadlines.length) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(
        20,
        Math.min(2147483647, Math.min(...deadlines) - Date.now() + 20),
      ),
    );
    return () => clearTimeout(timer);
  }, [server, now]);
  /** Where the learner was in the lesson when they opened their profile or
   * record: the scroll position and the focused element. Tracked as it changes,
   * because hiding the lesson shortens the page and clamps the scroll. */
  const lessonPlace = useRef<{ top: number; focus: HTMLElement | null }>({ top: 0, focus: null });
  const lessonAnchor = useRef<{ episodeId: string; top: number; focus: HTMLElement | null } | null>(null);
  const scroller = () =>
    wide ? null : document.querySelector<HTMLElement>(".connected-main");
  const learning = view === "learn" && Boolean(episodeId);
  useEffect(() => {
    if (!learning) return;
    const scrolled = () => {
      lessonPlace.current.top = scroller()?.scrollTop ?? window.scrollY;
    };
    const focused = (event: FocusEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest?.(".connected-lesson-keeper")) return;
      lessonPlace.current.focus = target;
      // Focus Not Obscured: a focused control behind the sticky answer actions
      // (or the sticky header) is scrolled clear of them.
      const bar = document.querySelector<HTMLElement>(".connected-answer-actions");
      if (!bar || bar.contains(target)) return;
      const box = target.getBoundingClientRect(), cover = bar.getBoundingClientRect();
      const behindBar = box.bottom > cover.top && box.top < cover.bottom;
      if (behindBar) (scroller() ?? window).scrollBy?.({ top: box.bottom - cover.top + 12, behavior: "instant" });
    };
    scrolled();
    document.addEventListener("scroll", scrolled, { capture: true, passive: true });
    document.addEventListener("focusin", focused);
    return () => {
      document.removeEventListener("scroll", scrolled, { capture: true });
      document.removeEventListener("focusin", focused);
    };
  }, [learning, wide]);
  const previousView = useRef(view);
  useLayoutEffect(() => {
    const from = previousView.current;
    previousView.current = view;
    if (from === "learn" && view !== "learn" && episodeId) {
      lessonAnchor.current = { episodeId, ...lessonPlace.current };
      // Media pauses while hidden; its position is kept.
      document
        .querySelectorAll(".connected-lesson-keeper video, .connected-lesson-keeper audio")
        .forEach((media) => (media as HTMLMediaElement).pause());
    }
  }, [view, episodeId]);
  const visibleHeading = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-reading-heading]")).find(
      (element) => !element.closest("[hidden]"),
    );
  useEffect(() => {
    if (view !== "learn") {
      // The lesson's place stays in lessonAnchor until learning resumes.
      visibleHeading()?.focus({ preventScroll: true });
      window.scrollTo?.({ top: 0, behavior: "instant" });
      document.querySelector<HTMLElement>(".connected-main")?.scrollTo?.({ top: 0, behavior: "instant" });
      return;
    }
    const anchor = lessonAnchor.current;
    lessonAnchor.current = null;
    if (anchor && anchor.episodeId === episodeId) {
      const target = scroller();
      if (target) target.scrollTo?.({ top: anchor.top, behavior: "instant" });
      else window.scrollTo?.({ top: anchor.top, behavior: "instant" });
      (anchor.focus?.isConnected && !anchor.focus.closest("[hidden]") ? anchor.focus : visibleHeading())?.focus({
        preventScroll: true,
      });
      return;
    }
    lessonPlace.current = { top: 0, focus: null };
    visibleHeading()?.focus({ preventScroll: true });
    window.scrollTo?.({ top: 0, behavior: "instant" });
    document.querySelector<HTMLElement>(".connected-main")?.scrollTo?.({top:0,behavior:"instant"});
  }, [episodeId, view]);
  // Snapshot loads can overlap: a panel's follow-up refresh may still be in
  // flight while the lesson saves and refreshes. Only the most recently started
  // load may replace what is shown, so a slower, older response never rolls the
  // lesson back underneath the learner (removing the check they are typing into).
  const snapshotLoads = useRef({ started: 0, shown: 0 });
  function clearServer() {
    const loads = snapshotLoads.current;
    loads.shown = ++loads.started;
    setServer(undefined);
  }
  async function refresh(id: string) {
    const loads = snapshotLoads.current,
      ticket = ++loads.started;
    const value = await api.load(id);
    if (ticket > loads.shown) {
      loads.shown = ticket;
      setServer(value);
    }
    const recovered = api.takeRecovered(id);
    if (recovered?.action === "answers")
      setNotice({ render: (t) => t("connectedHost.notice.recoveredSubmission", { feedback: answerFeedback(recovered.result, false, t) }) });
    if (recovered?.action === "companion") setNotice({ render: (t) => t("connectedHost.notice.recoveredMessage") });
    return value;
  }
  async function loadAccount() {
    const data = await initialApi.request<{ user: Account }>("/auth/session");
    if (data.user.id !== account?.id) {
      setPreview(undefined);
      setStartAttempts({});
      clearServer();
      setEpisodeId(undefined);
    }
    setAccount(data.user);
    // Apply the saved language preference, or save the choice made on this device.
    void fetchServerLocale(initialApi.request)
      .then((serverLocale) => {
        const save = localeControl.adoptServer(serverLocale);
        if (save) void saveServerLocale(initialApi.request, save).catch(() => {});
      })
      .catch(() => {});
    const [saved, workspaces] = await Promise.all([
      initialApi.request<Enrollment[]>("/api/enrollments"),
      initialApi.request<{ id: string }[]>("/api/workspaces"),
    ]);
    setEnrollments(saved);
    const lists = await Promise.all(
      workspaces.map((workspace) =>
        initialApi.request<CatalogCourse[]>(
          `/api/workspaces/${encodeURIComponent(workspace.id)}/courses`,
        ),
      ),
    );
    setCatalog(lists.flat().filter((course) => course.status === "published"));
  }
  /** Mark a panel-owned mutation (placement, retention) as in flight, so the
   * lesson cannot start a second saved request before this one is confirmed.
   * The panel keeps its own error messages. */
  async function inFlight<T>(action: () => Promise<T>): Promise<T> {
    // i18n-ignore: internal guard, callers catch it and show nothing
    if (busy.current) throw new Error("Another request is pending");
    busy.current = true;
    setPending(true);
    try {
      return await action();
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  async function transact<T>(action: () => Promise<T>): Promise<T> {
    // i18n-ignore: internal guard, callers catch it and show nothing
    if (busy.current) throw new Error("Another request is pending");
    busy.current = true;
    setPending(true);
    setError("");
    setNotice(null);
    try {
      return await action();
    } catch (cause) {
      // The message appears above the lesson: keep the learner's place, so what they were
      // answering does not slide under the answer actions.
      const restore = keepLessonPlace(scroller);
      setError(
        cause instanceof CourseApiError && cause.code === "NETWORK_UNCERTAIN" && !navigator.onLine
          ? t("connectedHost.error.offline")
          : cause instanceof CourseApiError
            ? apiErrorMessage(cause.code, t, cause.details)
            : t("connectedHost.error.requestFailed"),
      );
      restore();
      if (cause instanceof CourseApiError && cause.code === "UNAUTHENTICATED") {
        setAccount(undefined);
        clearServer();
        setEpisodeId(undefined);
        setCompanionOpen(false);
      }
      if (
        server &&
        cause instanceof CourseApiError &&
        [
          "STALE_REVISION",
          "CHALLENGE_EXPIRED",
          "ASSESSMENT_HELP_CONSENT_REQUIRED",
          "GATE_NOT_READY",
          "GATE_DECISION_STALE",
          "GATE_DECISION_UNLINKED",
          "GATE_REVIEW_OPEN",
          "GATE_DECISION_NOT_REVIEWABLE",
          "GATE_EXCEPTION_GRANTED",
          "EVIDENCE_REQUIRED",
        ].includes(cause.code)
      )
        await refresh(server.enrollmentId).catch(() => {});
      throw cause;
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  function run(action: () => Promise<unknown>) {
    void transact(action).catch(() => {});
  }
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1)),
      token = params.get("signin");
    if (token)
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
    void (async () => {
      try {
        if (token) await initialApi.request("/auth/redeem", "POST", { token });
        await loadAccount();
      } catch (cause) {
        if (token)
          setError(
            cause instanceof CourseApiError ? apiErrorMessage(cause.code, t) : t("connectedHost.error.signInFailed"),
          );
        // Signed out: one-time codes are offered only when the server enables them.
        await initialApi
          .request<{ loginCodes?: unknown; passkeys?: unknown }>("/auth/options")
          .then((options) => {
            setLoginCodes(options.loginCodes === true);
            setPasskeys(options.passkeys === true);
          })
          .catch(() => {
            setLoginCodes(false);
            setPasskeys(false);
          });
      } finally {
        setReady(true);
      }
    })();
  }, []);
  async function command<T>(
    action: string,
    data: Record<string, unknown>,
  ): Promise<T> {
    // i18n-ignore: programming guard, never shown
    if (!server) throw new Error("No enrollment");
    const result = await api.command<T>(server, action, data);
    await refresh(server.enrollmentId);
    return result;
  }
  function openEpisode(id: string, asPlacement = false) {
    setEpisodeId(id);
    setPlacement(asPlacement);
    setError("");
    setNotice(null);
    setView("learn");
  }
  async function submitAnswer(item: Challenge) {
    const payload = answerPayload(item.question, answer, t);
    if ("error" in payload) {
      setError(payload.error);
      return;
    }
    const value = payload.value, chosen = confidence[item.challengeId];
    if (item.question.type === "code" || item.question.type === "code_repair") {
      const problem = codeSubmissionError(item.question.language, answer, t);
      if (problem) {
        setError(problem);
        return;
      }
    }
    setCheckingAnswer(true);
    setSavingAnswer(true);
    try {
      const result = await command<{
        result: { passed: boolean; explanation: string; independent: boolean };
      }>("answers", { challengeId: item.challengeId, answer: value, ...(chosen ? { confidence: chosen } : {}) });
      setNotice({ render: (t) => answerFeedback(result, item.question.type === "code" || item.question.type === "code_repair", t) });
    } finally {
      setCheckingAnswer(false);
      setSavingAnswer(false);
    }
  }
  /** "I don't know yet": records no answer and no evidence; confidence stays optional. */
  async function abstain(item: Challenge) {
    const chosen = confidence[item.challengeId];
    setSavingAnswer(true);
    try {
      const result = await command("answers", { challengeId: item.challengeId, abstain: true, ...(chosen ? { confidence: chosen } : {}) });
      setNotice({ render: (t) => answerFeedback(result, false, t) });
    } finally {
      setSavingAnswer(false);
    }
  }
  function startCheck(assessmentId?: string) {
    return run(() => {
      const recovery = server?.recovery?.find((r) => r.episodeId === episodeId)?.freshCheck;
      return recovery && !placement && !assessmentId
        ? command("adaptation/fresh-question", {
            episodeId, objectiveId: recovery.objectiveId, familyId: recovery.familyId, mode: "independent", expectedPlanRevision: server?.planRevision ?? 0,
          })
        : command("challenges", { episodeId, mode: placement ? "placement" : "independent", ...(assessmentId ? { assessmentId } : {}) });
    });
  }
  function completeEpisode() {
    const decisionId = server?.lessons.find((l) => l.id === episodeId)?.gate?.decisionId;
    run(async () => {
      await command("complete", { episodeId, ...(placement ? { placement: true } : {}), ...(decisionId && !placement ? { gateDecisionId: decisionId } : {}) });
      setEpisodeId(undefined);
      setPlacement(false);
      setNotice({ render: (t) => t("connectedHost.notice.progressSaved") });
    });
  }
  /** A next step offered by the server's gate decision. Each one only navigates or starts a
   * normal server command; none of them grants credit. */
  function gateAction(action: NextAction) {
    const scrollTo = (selector: string) => document.querySelector(selector)?.scrollIntoView({ behavior: "smooth", block: "start" });
    if (action.kind === "continue") return completeEpisode();
    // The server offers no companion help when the study version withholds it; an older decision
    // still on screen falls back to the lesson, never to a hidden panel.
    if (action.kind === "request_help" && server?.studyArm?.companion !== false) return wide ? setPaneCollapsed(false) : setCompanionOpen(true);
    if (action.kind === "attempt_check") {
      // A reviewer's follow-up is answered in the review thread, not with a fresh check.
      if (action.targetId?.startsWith("gate-conversation:") && server?.lessons.find((l) => l.id === episodeId)?.gate?.status === "under_review") return scrollTo(".connected-reviews");
      return startCheck(action.targetId);
    }
    if (action.kind === "review_material" || action.kind === "request_help") {
      const review = document.querySelector<HTMLDetailsElement>(".connected-review");
      if (review) review.open = true;
      return scrollTo(".connected-review, .connected-reading-card, .connected-lesson-heading");
    }
    if (action.kind === "consider_extension") {
      const panel = document.querySelector<HTMLDetailsElement>(".connected-policy-panel");
      if (panel) panel.open = true;
      return scrollTo(".connected-policy-panel");
    }
    // "appeal" opens the review request form inside the decision panel.
    if (action.kind === "view_gaps") return scrollTo(".connected-gate-criteria");
  }
  /** Asks staff to review the checkpoint decision the learner is looking at. It changes nothing
   * by itself; staff uphold the decision or authorize an exception. */
  function requestGateReview(reason: string) {
    const gate = server?.lessons.find((l) => l.id === episodeId)?.gate;
    if (!server || !gate?.gateId) return Promise.resolve();
    const gateId = encodeURIComponent(gate.gateId);
    return transact(async () => {
      const decisionId = gate.decisionId ?? (await api.request<{ decision: { decisionId: string } }>(
        `/api/enrollments/${encodeURIComponent(server.enrollmentId)}/gates/${gateId}/decision`)).decision.decisionId;
      await command(`gates/${gateId}/review-requests`, { decisionId, reason });
      setNotice({ render: (t) => t("connectedHost.notice.reviewRequested") });
    });
  }
  async function startCourse(course: CatalogCourse) {
    const current = await api.request<Enrollment[]>("/api/enrollments");
    setEnrollments(current);
    const existing = current.find(
      (enrollment) => enrollment.releaseId === course.id,
    );
    let id = existing?.id;
    if (!id) {
      setStartAttempts((value) => ({ ...value, [course.id]: true }));
      id = (
        await api.request<{ id: string }>("/api/enrollments", "POST", {
          releaseId: course.id,
        })
      ).id;
    }
    await refresh(id);
    setPreview(undefined);
    setEpisodeId(undefined);
    setView("learn");
  }
  async function decideOffer(offer: ExtensionOffer, accept: boolean) {
    if (!server || !policy.data || policy.loading)
      // i18n-ignore: programming guard, the offer buttons are hidden without a policy
      throw new Error("Policy unavailable");
    try {
      if (accept) {
        const result = await policyClient.accept(
          server,
          policy.data,
          offer,
          true,
        );
        await refresh(server.enrollmentId);
        setNotice({ render: (t) => result.offer.state === "granted"
            ? t("connectedHost.notice.extensionGranted")
            : t("connectedHost.notice.extensionAwaitingApproval"), });
      } else {
        await policyClient.decline(server, policy.data, offer);
        await refresh(server.enrollmentId);
        setNotice({ render: (t) => t("connectedHost.notice.offerDeclined") });
      }
    } finally {
      policy.reload();
    }
  }
  const policyPanel = server ? (
    <PolicyPanel
      server={server}
      episodeId={episodeId}
      data={policy.data}
      loading={policy.loading}
      error={policy.error}
      pending={pending}
      onRefresh={policy.reload}
      onAccept={(offer) => run(() => decideOffer(offer, true))}
      onDecline={(offer) => run(() => decideOffer(offer, false))}
    />
  ) : null;
  async function sendCompanion(
    content: string,
    consent?: true,
  ): Promise<CompanionReceipt> {
    try {
      return await sendCompanionNow(content, consent);
    } catch (cause) {
      if (cause instanceof CourseApiError && cause.code === "HELP_BUDGET_EXHAUSTED") {
        const budget = cause.details?.budget;
        setQuestionsExhausted({ budget: typeof budget === "number" ? budget : undefined });
        policy.reload();
      }
      throw cause;
    }
  }
  async function sendCompanionNow(
    content: string,
    consent?: true,
  ): Promise<CompanionReceipt> {
    // i18n-ignore: programming guard, the companion is only offered inside a lesson
    if (!server || !episode) throw new Error("Open a lesson first");
    const frame = visualFrame.current;
    const interactiveContext = frame?.scope === readingScope && frame.context.episodeId === episode.id
      && frame.context.blockId === context.blockId ? structuredClone(frame.context) : undefined;
    return transact(async () => {
      const result = await chat.send(server, {
        episodeId: episode.id,
        ...(context.blockId ? { blockId: context.blockId } : {}),
        content,
        ...(interactiveContext ? { interactiveContext } : {}),
        ...(consent === true
          ? { allowAssessmentAssistance: true as const }
          : {}),
      });
      // A queued receipt is authoritative even if the subsequent snapshot GET fails.
      // Reflect only the explicit assistance downgrade; never infer a passed check.
      setServer((current) =>
        current?.enrollmentId === server.enrollmentId
          ? {
              ...current,
              revision: Math.max(current.revision, result.revision),
              activeChallenges: current.activeChallenges.map((item) =>
                result.downgradedChallengeIds.includes(item.challengeId)
                  ? { ...item, independentEligible: false }
                  : item,
              ),
            }
          : current,
      );
      try {
        await refresh(server.enrollmentId);
      } catch {
        setError(t("connectedHost.error.queuedRefreshFailed"));
      }
      return result;
    });
  }
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const hasRecovery = pendingAction !== null;
  const online = useOnline();
  const checkPending = useCallback(() => {
    try {
      setPendingAction(server ? api.pendingAction(server.enrollmentId) : null);
    } catch {
      setPendingAction("");
    }
  }, [api, server?.enrollmentId]);
  // A request this page is still sending is not "waiting": its record is written before it is
  // sent and removed when the server answers. Only a record left once nothing is in flight (a
  // failed or interrupted send, or one from an earlier visit) is reported and offered again.
  useEffect(() => {
    if (!pending) checkPending();
  }, [checkPending, server?.revision, pending, error]);
  /** Send a saved, unconfirmed request again with its original idempotency key;
   * the server records it at most once. */
  const resend = useRef<() => void>(() => {});
  resend.current = () => {
    if (!server || busy.current) return;
    if (!navigator.onLine) return;
    try {
      if (!api.hasPending(server.enrollmentId)) return;
    } catch {
      /* A corrupt record is reported by the retry itself. */
    }
    run(() => refresh(server.enrollmentId));
  };
  // Reconnecting sends what was waiting, once.
  useEffect(() => {
    if (online) resend.current();
  }, [online]);
  // Returning to the page: send what is waiting, and after a longer absence
  // fetch progress again (another device may have moved on).
  usePageReturn((away) => {
    if (!server || busy.current || !navigator.onLine) return;
    checkPending();
    try {
      if (api.hasPending(server.enrollmentId)) return resend.current();
    } catch {
      return;
    }
    if (away > 60_000) void refresh(server.enrollmentId).catch(() => {});
  });
  function openRecord() {
    if (!server) return;
    run(async () => {
      const result = await api.request<{ events: typeof events }>(
        `/api/enrollments/${encodeURIComponent(server.enrollmentId)}/events`,
      );
      setEvents(result.events);
      setView("activity");
    });
  }
  function leaveCourse() {
    setView("learn");
    clearServer();
    setEpisodeId(undefined);
    setPlacement(false);
    setCompanionOpen(false);
    run(loadAccount);
  }
  function saveLocale(locale: AppLocale) {
    if (!account || !isSupportedLocale(locale)) return;
    saveServerLocale(api.request, locale).catch(() => setError(t("connectedHost.languageSaveFailed")));
  }
  function signOut() {
    run(async () => {
      // Signing out ends the study session (trigger T10 "session ended"); best effort.
      if (server?.enrollmentId) await api.notify(`/api/enrollments/${encodeURIComponent(server.enrollmentId)}/session/end`);
      signingOut.current = true;
      try {
        await api.request("/auth/logout", "POST");
      } catch (error) {
        signingOut.current = false;
        throw error;
      }
      drafts.clear();
      setAccount(undefined);
      clearServer();
      setEpisodeId(undefined);
      setCatalog([]);
      setEnrollments([]);
      setPreview(undefined);
      setStartAttempts({});
      setCompanionOpen(false);
      setChangingPassword(false);
      setManagingPasskeys(false);
      setView("learn");
    });
  }
  function back() {
    if (view !== "learn") {
      setView("learn");
      return;
    }
    if (episode) {
      setEpisodeId(undefined);
      setPlacement(false);
      return;
    }
    leaveCourse();
  }
  return (
    <div ref={hostRef} className={`connected-host window-${size} ${wide ? "" : "is-compact"}`} data-window-class={size}>
      <header className="connected-header" data-connected-background>
        <div className="connected-header-inner">
          <div className="connected-brand">
            {/* i18n-ignore: product name, not translated */}
            <span lang="en" dir="ltr">Course Core</span> <span>{t("connectedHost.brandSection")}</span>
          </div>
          {account && (
            <YourCourseMenu
              label={server ? t("connectedHost.menu.yourCourse") : t("connectedHost.menu.account")}
              description={
                server && policy.data?.coverage
                  ? t("connectedHost.menu.signedInWithCoverage", {
                      name: account.displayName,
                      coverage: coverageText(policy.data.coverage, t).core,
                    })
                  : t("connectedHost.menu.signedIn", { name: account.displayName })
              }
              groups={[
                {
                  label: server ? server.course.title : t("connectedHost.menu.yourCourses"),
                  items: server
                    ? [
                        {
                          label: t("connectedHost.menu.learningPath"),
                          current: view === "learn" && !episode,
                          disabled: pending,
                          onSelect: () => {
                            setView("learn");
                            setEpisodeId(undefined);
                            setPlacement(false);
                          },
                        },
                        {
                          label: t("connectedHost.menu.profile"),
                          current: view === "profile",
                          disabled: pending,
                          onSelect: () => setView("profile"),
                        },
                        {
                          label: t("connectedHost.menu.record"),
                          current: view === "activity",
                          disabled: pending,
                          onSelect: openRecord,
                        },
                        {
                          label: t("connectedHost.menu.allCourses"),
                          disabled: pending,
                          onSelect: leaveCourse,
                        },
                      ]
                    : [],
                },
                {
                  label: t("connectedHost.menu.account"),
                  items: [
                    ...(account.hasPassword
                      ? [{ label: t("connectedHost.menu.changePassword"), disabled: pending || changingPassword, onSelect: () => setChangingPassword(true) }]
                      : []),
                    ...(passkeysSupported()
                      ? [{ label: t("connectedHost.menu.passkeys"), disabled: pending || managingPasskeys, onSelect: () => setManagingPasskeys(true) }]
                      : []),
                    { label: t("connectedHost.menu.signOut"), disabled: pending, onSelect: signOut },
                  ],
                },
              ]}
            />
          )}
        </div>
      </header>
      <div
        className={`connected-layout ${server && account && paneShown ? "with-companion" : ""}`}
      >
        <main
          className="connected-main"
          data-connected-background
          id="connected-learning"
          tabIndex={wide?undefined:0}
          aria-label={t("connectedHost.main")}
        >
          {server && (
            <nav
              className="connected-navigation"
              aria-label={t("connectedHost.navigation")}
            >
              <button type="button" onClick={back} disabled={pending}>
                <span className="connected-flip-rtl">←</span>{" "}
                {view !== "learn"
                  ? t("connectedHost.back.learning")
                  : episode
                    ? t("connectedHost.back.roadmap")
                    : t("connectedHost.back.allCourses")}
              </button>
            </nav>
          )}
          {error && (
            <Notice error>
              {error}
              {server && !hasRecovery && (
                <Button
                  label={t("connectedHost.refreshProgress")}
                  kind="quiet"
                  disabled={pending}
                  onPress={() => run(() => refresh(server.enrollmentId))}
                />
              )}
            </Notice>
          )}
          {notice && <Notice>{notice.render(t)}</Notice>}
          {server && (storageUnavailable || drafts.unavailable) && (
            <Notice>
              {t("connectedHost.storageUnavailable")}
            </Notice>
          )}
          {account && (
            <ConnectionStatus
              online={online}
              pendingAction={server ? pendingAction : null}
              pending={pending}
              slow={slowRequest}
              onRetry={() => server && run(() => refresh(server.enrollmentId))}
            />
          )}
          {episode && view === "learn" && answerConflict && drafts.version(answerKey) && (
            <DraftConflict
              label={t("connectedHost.draft.answer")}
              shown={drafts.version(answerKey)!}
              other={answerConflict}
              onKeepShown={() => drafts.resolve(answerKey, "shown")}
              onUseOther={() => drafts.resolve(answerKey, "other")}
            />
          )}
          {account && changingPassword && (
            <ChangePassword
              request={api.request}
              loginName={account.loginName}
              onClose={(changed) => {
                setChangingPassword(false);
                if (changed)
                  setNotice({ render: (t) => t("connectedHost.passwordChanged") });
              }}
            />
          )}
          {account && managingPasskeys && (
            <PasskeyManager
              request={api.request}
              loginName={account.loginName}
              hasPassword={account.hasPassword === true}
              onClose={() => setManagingPasskeys(false)}
            />
          )}
          {!ready ? (
            <ActivityIndicator accessibilityLabel={t("connectedHost.loading")} />
          ) : !account ? (
            <section className="connected-signin">
              <LocaleSwitcher />
              <Badge label={t("connectedHost.signIn.badge")} />
              <h1>{t("connectedHost.signIn.title")}</h1>
              <p>{t(passkeys ? "connectedHost.signIn.introPasskeys" : "connectedHost.signIn.intro")}</p>
              <PasswordSignIn
                request={initialApi.request}
                loginCodes={loginCodes}
                onSignedIn={loadAccount}
              />
              {passkeys && passkeysSupported() && (
                <PasskeySignIn
                  request={initialApi.request}
                  onSignedIn={loadAccount}
                />
              )}
              <Button
                label={t("connectedHost.signIn.demo")}
                kind="quiet"
                onPress={() => window.location.assign("/demo")}
              />
            </section>
          ) : !server && preview ? (
            <EnrollmentPreview
              course={preview}
              pending={pending}
              attempted={startAttempts[preview.id]}
              onBack={() => setPreview(undefined)}
              onStart={() => run(() => startCourse(preview))}
            />
          ) : !server ? (
            <section className="connected-library">
              <h1>{t("connectedHost.library.title")}</h1>
              {enrollments.map((enrollment) => (
                <article className="connected-reading-card" key={enrollment.id}>
                  <h2 {...courseContentAttributes()}>{enrollment.title}</h2>
                  <p>
                    {t("connectedHost.library.versionStatus", {
                      version: enrollment.version,
                      status: enrollmentStatus(enrollment.status),
                    })}
                  </p>
                  {enrollment.status !== "erased" && <Button
                    label={t("connectedHost.library.continue")}
                    kind="primary"
                    disabled={pending}
                    onPress={() =>
                      run(async () => {
                        await refresh(enrollment.id);
                        setEpisodeId(undefined);
                        setView("learn");
                      })
                    }
                  />}
                </article>
              ))}
              <h2>{t("connectedHost.library.available")}</h2>
              {catalog.length ? (
                catalog.map((course) => (
                  <article className="connected-reading-card" key={course.id}>
                    <h2 {...courseContentAttributes()}>{course.title}</h2>
                    <p>{t("connectedHost.library.version", { version: course.version })}</p>
                    {enrollments.some(
                      (enrollment) =>
                        enrollment.releaseId === course.id &&
                        enrollment.status === "erased",
                    ) ? (
                      <p className="connected-muted">
                        {t("connectedHost.library.erased")}
                      </p>
                    ) : (
                    <Button
                      label={
                        enrollments.some(
                          (enrollment) => enrollment.releaseId === course.id,
                        )
                          ? t("connectedHost.library.resume")
                          : t("connectedHost.library.open")
                      }
                      disabled={pending}
                      onPress={() => {
                        const existing = enrollments.find(
                          (enrollment) => enrollment.releaseId === course.id,
                        );
                        if (existing)
                          run(async () => {
                            await refresh(existing.id);
                            setEpisodeId(undefined);
                            setView("learn");
                          });
                        else setPreview(course);
                      }}
                    />
                    )}
                  </article>
                ))
              ) : (
                <Notice>
                  {t("connectedHost.library.empty")}
                </Notice>
              )}
            </section>
          ) : view === "profile" ? (
            <section className="connected-reading-card">
              <LocaleSwitcher onChosen={saveLocale} />
              <ProfileEditor
                identityOnly
                profile={server.profile}
                pending={pending}
                saved={false}
                demo={false}
                onSave={(profile: Profile) =>
                  run(async () => {
                    await command("profile", { profile, identityOnly: true });
                    setView("learn");
                    setNotice({ render: (t) => t("connectedHost.notice.profileSaved") });
                  })
                }
              />
              {account && <SupervisionPanel accountId={account.id} enrollment={server} client={supervisionClient} mode="settings" pending={pending} onRevision={() => refresh(server.enrollmentId)} />}
              <LearnerMemoryPanel account={account} enrollment={server} api={memoryClient}
                episodeId={episodeId ?? server.nextEpisodeId ?? undefined}
                onRevision={() => { void refresh(server.enrollmentId); }} />
              {account && <TeachingHypothesesPanel key={`${account.id}:${server.enrollmentId}`} enrollment={server} client={hypothesisClient}
                episodeId={episodeId ?? server.nextEpisodeId ?? undefined}
                onRevision={() => { void refresh(server.enrollmentId); }} />}
              <PersonalChanges api={api} server={server} onChanged={() => void refresh(server.enrollmentId)} />
              <SupervisorRequests api={api} server={server} onChanged={() => void refresh(server.enrollmentId)} />
              <ReviewAssistConsent api={api} server={server} onChanged={() => void refresh(server.enrollmentId)} />
              <StudyConsent api={api} server={server} mode="settings" onChanged={() => void refresh(server.enrollmentId)} />
              <YourDataPanel api={api} enrollmentId={server.enrollmentId} courseTitle={server.course.title}
                onErased={() => {
                  clearServer();
                  setEpisodeId(undefined);
                  setCompanionOpen(false);
                  setView("learn");
                  run(async () => {
                    await loadAccount();
                    setNotice({ render: (t) => t("connectedHost.notice.dataErased") });
                  });
                }} />
              <ConnectedAgentsPanel key={server.enrollmentId} api={api} enrollmentId={server.enrollmentId} courseTitle={server.course.title} />
              <CrossCoursePanel key={`cross:${server.enrollmentId}`} api={api} enrollmentId={server.enrollmentId} courseTitle={server.course.title} />
            </section>
          ) : view === "activity" ? (
            <section className="connected-reading-card">
              <h1 data-reading-heading tabIndex={-1}>
                {t("connectedHost.record.title")}
              </h1>
              <p>{t("connectedHost.record.intro")}</p>
              {account && <SupervisionPanel accountId={account.id} enrollment={server} client={supervisionClient} mode="timeline" pending={pending} onRevision={() => refresh(server.enrollmentId)} />}
              {events.map((event) => (
                <div key={event.id}>
                  <p>
                    {t(RECORD_EVENTS.has(event.event_type)
                      ? (`connectedHost.record.event.${event.event_type.replace(".", "_")}` as MessageKey)
                      : "connectedHost.record.event.other")}
                  </p>
                  <time dateTime={event.created_at}>
                    {i18n.dateTime(event.created_at)}
                  </time>
                </div>
              ))}
            </section>
          ) : !episode && model ? (
            <FirstLoadProvider value={reportFirstLoad}>
              {!coursePageSettled && <ActivityIndicator accessibilityLabel={t("connectedHost.loading")} />}
              <div className="connected-course-page" hidden={!coursePageSettled} aria-busy={!coursePageSettled}>
              <CourseVersionNotice server={server} />
              <CourseVersionOffer
                server={server}
                onDecide={(moveId, accept) =>
                  command<{ status: "moved" | "waiting" | "declined" | "withdrawn" }>(
                    accept ? "version-offer/accept" : "version-offer/decline",
                    { moveId },
                  )
                }
              />
              <StudyConsent api={api} server={server} mode="prompt" onChanged={() => void refresh(server.enrollmentId)} />
              {policyPanel}
              <ClosureSummary server={server} />
              {(server.closureReport || server.complete) && (
                <ContinuationTrack api={api} server={server} onChanged={() => void refresh(server.enrollmentId)} />
              )}
              <PlacementRun
                key={server.enrollmentId}
                api={api}
                command={(action, data) =>
                  inFlight(async () => {
                    // Sequential placement steps must use the latest revision, not a render-time snapshot.
                    const fresh = await api.load(server.enrollmentId);
                    const result = await api.command<never>(fresh, action, data);
                    await refresh(server.enrollmentId);
                    return result;
                  })
                }
                enrollmentId={server.enrollmentId}
                firstEpisodeId={server.course.chapters[0]?.episodes[0]?.id ?? ""}
                onFinished={() => void refresh(server.enrollmentId)}
                onOpenChange={setPlacementOpen}
              />
              <RetentionPanel
                api={api}
                enrollmentId={server.enrollmentId}
                revision={server.revision}
                onStart={async (objectiveId) => {
                  const issued = await inFlight(async () => {
                    const fresh = await api.load(server.enrollmentId);
                    const result = await api.command<{ episodeId: string }>(fresh, "retention/check", { objectiveId });
                    await refresh(server.enrollmentId);
                    return result;
                  });
                  openEpisode(issued.episodeId);
                }}
                onSaveAvailability={async (weekdays, timeZone) => {
                  await inFlight(async () => {
                    const fresh = await api.load(server.enrollmentId);
                    await api.command<never>(fresh, "retention/availability", { weekdays, timeZone });
                    await refresh(server.enrollmentId);
                  });
                }}
              />
              <CourseRoadmap
                course={model.course}
                snapshot={model.snapshot}
                compact={compact}
                {...(policy.data?.coverage ? { coverage: policy.data.coverage } : {})}
                onOpenLesson={(lesson) => openEpisode(lesson.id)}
                onPlacement={() => {
                  // The card is shown only while this panel is on screen.
                  const panel = document.getElementById(PLACEMENT_PANEL_ID);
                  panel?.scrollIntoView({ behavior: "smooth", block: "start" });
                  panel?.focus({ preventScroll: true });
                }}
              />
              </div>
            </FirstLoadProvider>
          ) : null}
          {server && episode && view === "learn" && inspectorAccess?.enrollmentId === server.enrollmentId && (
            <DebugInspector access={inspectorAccess.access} enrollmentId={server.enrollmentId} episodeId={episode.id}
              blockId={block.scope === readingScope ? block.id : undefined} windowSize={size} />
          )}
          {server && episode && (
            // Kept mounted while the profile or record is open, so returning to
            // learning restores the reading place, media time and open details.
            <div className="connected-lesson-keeper" hidden={view !== "learn"}>
            <ConnectedLesson
              key={episode.id}
              server={server}
              episode={episode}
              placement={placement}
              pending={pending}
              now={now}
              answer={answer}
              checkingAnswer={checkingAnswer}
              savingAnswer={savingAnswer}
              policyPanel={policyPanel}
              components={components}
              pendingChanges={
                <PendingChangesNotice
                  items={pendingAdditions}
                  episodeId={episode.id}
                  pending={pending}
                  onAdd={(pendingId) =>
                    run(async () => {
                      // The addition lands at the end of the lesson; the learner stays where they were.
                      const restore = keepLessonPlace(scroller);
                      const result = await command<{ status: string }>("personal-changes/pending/apply", { pendingId });
                      restore();
                      setNotice({ render: (t) => result.status === "applied" ? t("pendingChanges.added") : t("pendingChanges.lapsed") });
                    })
                  }
                  onDecline={(pendingId) =>
                    run(async () => {
                      await command("personal-changes/pending/decline", { pendingId });
                      setNotice({ render: (t) => t("pendingChanges.declined") });
                    })
                  }
                />
              }
              resources={resourcesClient}
              reviews={reviewsLoader}
              onReviewReply={async (attemptId, text) => { await command(`reviews/${encodeURIComponent(attemptId)}/reply`, { answer: text }); }}
              onReviewAppeal={async (attemptId, reason) => { await command(`reviews/${encodeURIComponent(attemptId)}/appeal`, { reason }); }}
              onAnswerChange={(value) => drafts.write(answerKey, value)}
              onBlockChange={onBlockChange}
              onVisualContextChange={onVisualContextChange}
              onVisualComplete={onVisualComplete}
              unverified={unverified}
              onReviewChange={reviewChange}
              onRead={(blockId) =>
                run(() => command("read", { episodeId, blockId }))
              }
              onStart={() => startCheck()}
              onAnswer={(item) => run(() => submitAnswer(item))}
              onAbstain={(item) => run(() => abstain(item))}
              confidence={challenge ? confidence[challenge.challengeId] ?? null : null}
              onConfidenceChange={(value) => challenge && setConfidence((all) => ({ ...all, [challenge.challengeId]: value }))}
              onGateAction={gateAction}
              onGateReview={requestGateReview}
              onSolution={(item) =>
                run(async () => {
                  const result = await command<{ explanation: string }>(
                    "solution",
                    { challengeId: item.challengeId },
                  );
                  setNotice({ render: () => result.explanation });
                })
              }
              onComplete={completeEpisode}
              onReturn={(id) => openEpisode(id)}
              onNormal={() => setPlacement(false)}
              onRefresh={() => run(() => refresh(server.enrollmentId))}
              activities={activityClient}
              onPresence={onPresence}
              onActivityChanged={() => run(() => refresh(server.enrollmentId))}
            />
            </div>
          )}
        </main>
        {/* A research-study version without the companion (the fixed path) does not offer it. */}
        {server && account && server.studyArm?.companion !== false && (
          <CompanionDock
            key={`${account.id}:${server.enrollmentId}`}
            wide={wide}
            open={companionOpen}
            onOpenChange={setCompanionOpen}
            collapsed={paneCollapsed}
            onCollapsedChange={setPaneCollapsed}
          >
            {companionConflict && drafts.version(draftKey) && (
              <DraftConflict
                label={t("connectedHost.draft.message")}
                shown={drafts.version(draftKey)!}
                other={companionConflict}
                onKeepShown={() => drafts.resolve(draftKey, "shown")}
                onUseOther={() => drafts.resolve(draftKey, "other")}
              />
            )}
            {closedAllowance && (
              <p className={`connected-closed-help ${helpExhausted ? "is-exhausted" : ""}`} role="status">
                {closedHelpText(closedAllowance, helpExhausted, t)}
              </p>
            )}
            <LiveConversation
              client={chat}
              enrollmentId={server.enrollmentId}
              open={paneShown || (!wide && companionOpen)}
              revision={server.revision}
              onUnansweredChange={setUnansweredQuestions}
            >
              {(conversation) => (
            <ConnectedCompanion
              context={context}
              messages={conversation.messages}
              episodeTitles={titles}
              draft={draft}
              onDraftChange={(value) => drafts.write(draftKey, value)}
              onSend={sendCompanion}
              onExcludeContext={
                chat.excludeContext
                  ? (messageId, excluded) =>
                      transact(async () => {
                        await chat.excludeContext!(server, messageId, excluded);
                        await refresh(server.enrollmentId);
                      })
                  : undefined
              }
              onCancelQuestion={
                chat.cancelQuestion
                  ? (messageId) =>
                      transact(async () => {
                        await chat.cancelQuestion!(server, messageId);
                        await refresh(server.enrollmentId);
                      })
                  : undefined
              }
              onDeleteMessage={
                chat.deleteMessage
                  ? (messageId) =>
                      transact(async () => {
                        await chat.deleteMessage!(server, messageId);
                        await refresh(server.enrollmentId);
                      })
                  : undefined
              }
              pending={pending}
              loaded={conversation.loaded}
              error={conversation.error}
              storageUnavailable={storageUnavailable || drafts.unavailable}
              unavailable={Boolean(
                (episode && server.inaccessibleEpisodeIds.includes(episode.id)) || helpExhausted,
              )}
            />
              )}
            </LiveConversation>
          </CompanionDock>
        )}
      </div>
    </div>
  );
}
/**
 * Holds the companion conversation (useCompanionConversation) and renders the companion from
 * it. Its updates re-render this subtree only; the page hears the one count it acts on, and
 * setting an unchanged count re-renders nothing.
 */
function LiveConversation({
  client,
  enrollmentId,
  open,
  revision,
  onUnansweredChange,
  children,
}: {
  client: ContextualCompanionClient;
  enrollmentId: string;
  open: boolean;
  revision: number;
  onUnansweredChange(count: number): void;
  children(conversation: ReturnType<typeof useCompanionConversation>): React.ReactNode;
}) {
  const conversation = useCompanionConversation(client, enrollmentId, open, revision);
  const unanswered = conversation.messages.filter(
    (message) => message.role === "learner" && ["refused", "failed", "cancelled"].includes(message.job_state ?? ""),
  ).length;
  useEffect(() => onUnansweredChange(unanswered), [unanswered, onUnansweredChange]);
  // Another enrollment's conversation starts from none.
  useEffect(() => () => onUnansweredChange(0), [onUnansweredChange]);
  return <>{children(conversation)}</>;
}
