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
  createCourseApi,
  CourseApiError,
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
import { CourseRoadmap } from "./components/CourseRoadmap";
import { ProfileEditor } from "./components/ProfileEditor";
import { LearnerMemoryPanel } from './components/LearnerMemoryPanel';
import { createMemoryClient } from './client/memoryClient';
import { createHypothesisClient } from './client/hypothesisClient';
import { TeachingHypothesesPanel } from './components/TeachingHypothesesPanel';
import { createSupervisionClient } from './client/supervisionClient';
import { createResourcesClient } from './client/resourcesClient';
import { YourDataPanel } from './components/YourDataPanel';
import { PlacementRun } from './components/PlacementRun';
import { RetentionPanel } from './components/RetentionPanel';
import { PersonalChanges } from './components/PersonalChanges';
import { ReviewAssistConsent } from './components/ReviewAssistConsent';
import type { WrittenReview } from './components/ReviewStatus';
import { SupervisionPanel } from './components/SupervisionPanel';
import { CompanionDock } from "./components/CompanionDock";
import { ConnectedCompanion } from "./components/ConnectedCompanion";
import { Badge, Button, Notice, styles } from "./components/ui";
import { ConnectedLesson } from "./connected/ConnectedLesson.web";
import type { VisualContextChange, VisualInteractionContext } from './components/VisualBlock';
import {
  createConnectedDraftStore,
  type BrowserStore,
} from "./connected/drafts";
import { mediaUrlExpiry } from "./connected/resources";
import { useKeyboardInset, useLayoutViewport } from "./connected/layoutViewport";
import { ConnectionStatus, DraftConflict, useOnline, usePageReturn } from "./connected/connectivity.web";
import { YourCourseMenu } from "./connected/YourCourseMenu.web";
import { companionPlacement, windowClass, type WindowClass } from "./domain/windowClass";
import { useCompanionConversation } from "./hooks/useCompanionConversation";
import type { Profile } from "./domain/types";
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
export function ConnectedHost({ companionClient }: ConnectedHostProps = {}) {
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
    [notice, setNotice] = useState("");
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
  const conversation = useCompanionConversation(
    chat,
    server?.enrollmentId,
    Boolean(server && (paneShown || (!wide && companionOpen))),
    server?.revision ?? 0,
  );
  const policyClient = useMemo(() => createPolicyClient(api), [api]);
  const memoryClient = useMemo(() => createMemoryClient(api, account?.id ?? 'signed-out'), [api, account?.id]);
  const hypothesisClient = useMemo(() => createHypothesisClient(api, account?.id ?? 'signed-out'), [api, account?.id]);
  const supervisionClient = useMemo(() => createSupervisionClient(api), [api]);
  const resourcesClient = useMemo(() => createResourcesClient(api), [api]);
  const reviewsLoader = useMemo(() => async (enrollmentId: string, signal: AbortSignal) =>
    (await api.request<{ reviews: WrittenReview[] }>(`/api/enrollments/${encodeURIComponent(enrollmentId)}/reviews`, "GET", undefined, { signal })).reviews, [api]);
  const policy = useEnrollmentPolicy(
    policyClient,
    server?.enrollmentId,
    server?.revision ?? 0,
  );
  const model = useMemo(
    () => (server ? presentation(server, { placementOpen }) : undefined),
    [server, placementOpen],
  );
  const episode = server?.course.chapters
    .flatMap((chapter) => chapter.episodes)
    .find((row) => row.id === episodeId);
  const challenge = server?.activeChallenges.find(
    (row) => row.episodeId === episodeId,
  );
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
  const codeQuestion = challenge?.question.type === "code" || challenge?.question.type === "code_repair" ? challenge.question : undefined;
  const answerKey = `${scope}:${codeQuestion ? "code-answer" : "answer"}:${challenge?.challengeId ?? "none"}`,
    draftKey = `${scope}:companion:${episodeId ?? "roadmap"}`;
  const answer = drafts.has(answerKey)
      ? drafts.read(answerKey)
      : codeQuestion
        ? codeQuestion.starterCode
        : "",
    draft = drafts.read(draftKey);
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
      setNotice(`Recovered submission. ${answerFeedback(recovered.result)}`);
    if (recovered?.action === "companion")
      setNotice(
        "Your saved message was recovered. Open the companion to see its status before sending another message.",
      );
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
    if (busy.current) throw new Error("Another request is pending");
    busy.current = true;
    setPending(true);
    setError("");
    setNotice("");
    try {
      return await action();
    } catch (cause) {
      setError(
        cause instanceof CourseApiError && cause.code === "NETWORK_UNCERTAIN" && !navigator.onLine
          ? "You’re offline. Nothing was recorded yet; your work is saved on this device and is sent when you reconnect."
          : cause instanceof CourseApiError
            ? cause.message
            : "The request could not be completed. Your draft is preserved. Please retry.",
      );
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
            cause instanceof CourseApiError ? cause.message : "Sign-in failed.",
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
    if (!server) throw new Error("No enrollment");
    const result = await api.command<T>(server, action, data);
    await refresh(server.enrollmentId);
    return result;
  }
  function openEpisode(id: string, asPlacement = false) {
    setEpisodeId(id);
    setPlacement(asPlacement);
    setError("");
    setNotice("");
    setView("learn");
  }
  async function submitAnswer(item: Challenge) {
    const payload = answerPayload(item.question, answer);
    if ("error" in payload) {
      setError(payload.error);
      return;
    }
    const value = payload.value, chosen = confidence[item.challengeId];
    if (item.question.type === "code" || item.question.type === "code_repair") {
      const problem = codeSubmissionError(item.question.language, answer);
      if (problem) {
        setError(problem);
        return;
      }
    }
    setCheckingAnswer(true);
    try {
      const result = await command<{
        result: { passed: boolean; explanation: string; independent: boolean };
      }>("answers", { challengeId: item.challengeId, answer: value, ...(chosen ? { confidence: chosen } : {}) });
      setNotice(answerFeedback(result, item.question.type === "code" || item.question.type === "code_repair"));
    } finally {
      setCheckingAnswer(false);
    }
  }
  /** "I don't know yet": records no answer and no evidence; confidence stays optional. */
  async function abstain(item: Challenge) {
    const chosen = confidence[item.challengeId];
    const result = await command("answers", { challengeId: item.challengeId, abstain: true, ...(chosen ? { confidence: chosen } : {}) });
    setNotice(answerFeedback(result));
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
      setNotice("Your progress is saved. Continue along your learning path.");
    });
  }
  /** A next step offered by the server's gate decision. Each one only navigates or starts a
   * normal server command; none of them grants credit. */
  function gateAction(action: NextAction) {
    const scrollTo = (selector: string) => document.querySelector(selector)?.scrollIntoView({ behavior: "smooth", block: "start" });
    if (action.kind === "continue") return completeEpisode();
    if (action.kind === "request_help") return wide ? setPaneCollapsed(false) : setCompanionOpen(true);
    if (action.kind === "attempt_check") {
      // A reviewer's follow-up is answered in the review thread, not with a fresh check.
      if (action.targetId?.startsWith("gate-conversation:") && server?.lessons.find((l) => l.id === episodeId)?.gate?.status === "under_review") return scrollTo(".connected-reviews");
      return startCheck(action.targetId);
    }
    if (action.kind === "review_material") {
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
      setNotice("Your review request was sent. A staff member will respond here; your saved work is unchanged.");
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
        setNotice(
          result.offer.state === "granted"
            ? "Your extension was granted. The saved dates and remaining allowance have been refreshed."
            : "Your acceptance is saved. The extension is waiting for approval; current dates still apply.",
        );
      } else {
        await policyClient.decline(server, policy.data, offer);
        await refresh(server.enrollmentId);
        setNotice(
          "The offer was declined. Your existing dates remain in effect.",
        );
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
        setError(
          "Your message is saved and queued, but progress could not refresh. Refresh before continuing.",
        );
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
  useEffect(checkPending, [checkPending, server?.revision, pending, error]);
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
  function signOut() {
    run(async () => {
      await api.request("/auth/logout", "POST");
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
            Course Core <span>/ learn</span>
          </div>
          {account && (
            <YourCourseMenu
              label={server ? "Your course" : "Account"}
              description={`Signed in as ${account.displayName}`}
              groups={[
                {
                  label: server ? server.course.title : "Your courses",
                  items: server
                    ? [
                        {
                          label: "Learning path",
                          current: view === "learn" && !episode,
                          disabled: pending,
                          onSelect: () => {
                            setView("learn");
                            setEpisodeId(undefined);
                            setPlacement(false);
                          },
                        },
                        {
                          label: "My profile",
                          current: view === "profile",
                          disabled: pending,
                          onSelect: () => setView("profile"),
                        },
                        {
                          label: "Learning record",
                          current: view === "activity",
                          disabled: pending,
                          onSelect: openRecord,
                        },
                        {
                          label: "All courses",
                          disabled: pending,
                          onSelect: leaveCourse,
                        },
                      ]
                    : [],
                },
                {
                  label: "Account",
                  items: [
                    ...(account.hasPassword
                      ? [{ label: "Change password", disabled: pending || changingPassword, onSelect: () => setChangingPassword(true) }]
                      : []),
                    ...(passkeysSupported()
                      ? [{ label: "Passkeys", disabled: pending || managingPasskeys, onSelect: () => setManagingPasskeys(true) }]
                      : []),
                    { label: "Sign out", disabled: pending, onSelect: signOut },
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
          aria-label="Learning content"
        >
          {server && (
            <nav
              className="connected-navigation"
              aria-label="Learning navigation"
            >
              <button type="button" onClick={back} disabled={pending}>
                ←{" "}
                {view !== "learn"
                  ? "Back to learning"
                  : episode
                    ? "Course roadmap"
                    : "All courses"}
              </button>
            </nav>
          )}
          {error && (
            <Notice error>
              {error}
              {server && !hasRecovery && (
                <Button
                  label="Refresh progress"
                  kind="quiet"
                  disabled={pending}
                  onPress={() => run(() => refresh(server.enrollmentId))}
                />
              )}
            </Notice>
          )}
          {notice && <Notice>{notice}</Notice>}
          {server && (storageUnavailable || drafts.unavailable) && (
            <Notice>
              Browser storage is unavailable. Drafts and pending retries stay in
              this tab only; confirm any interrupted request before closing it.
            </Notice>
          )}
          {account && (
            <ConnectionStatus
              online={online}
              pendingAction={server ? pendingAction : null}
              pending={pending}
              onRetry={() => server && run(() => refresh(server.enrollmentId))}
            />
          )}
          {episode && view === "learn" && answerConflict && drafts.version(answerKey) && (
            <DraftConflict
              label="Your answer"
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
                  setNotice(
                    "Your password was changed. Your other sessions were signed out.",
                  );
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
            <ActivityIndicator accessibilityLabel="Loading your saved learning space" />
          ) : !account ? (
            <section className="connected-signin">
              <Badge label="Your private learning space" />
              <h1>Pick up where you left off.</h1>
              <p>
                Sign in with the username and password from your course team
                {passkeys ? ", or with a passkey you have added" : ""}. Your
                course history stays with your account.
              </p>
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
                label="Explore the public demo"
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
              <h1>Your courses</h1>
              {enrollments.map((enrollment) => (
                <article className="connected-reading-card" key={enrollment.id}>
                  <h2>{enrollment.title}</h2>
                  <p>
                    Version {enrollment.version} ·{" "}
                    {enrollment.status === "erased" ? "learning data erased" : enrollment.status}
                  </p>
                  {enrollment.status !== "erased" && <Button
                    label="Continue learning →"
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
              <h2>Available in your workspace</h2>
              {catalog.length ? (
                catalog.map((course) => (
                  <article className="connected-reading-card" key={course.id}>
                    <h2>{course.title}</h2>
                    <p>Version {course.version}</p>
                    {enrollments.some(
                      (enrollment) =>
                        enrollment.releaseId === course.id &&
                        enrollment.status === "erased",
                    ) ? (
                      <p className="connected-muted">
                        You erased your learning data for this version, so it
                        cannot be resumed. Ask your course team if you want to
                        start again.
                      </p>
                    ) : (
                    <Button
                      label={
                        enrollments.some(
                          (enrollment) => enrollment.releaseId === course.id,
                        )
                          ? "Resume course"
                          : "Open course"
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
                  No published course is available yet. Your course team can
                  publish a course for you.
                </Notice>
              )}
            </section>
          ) : view === "profile" ? (
            <section className="connected-reading-card">
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
                    setNotice("Your profile is saved.");
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
              <ReviewAssistConsent api={api} server={server} onChanged={() => void refresh(server.enrollmentId)} />
              <YourDataPanel api={api} enrollmentId={server.enrollmentId} courseTitle={server.course.title}
                onErased={() => {
                  clearServer();
                  setEpisodeId(undefined);
                  setCompanionOpen(false);
                  setView("learn");
                  run(async () => {
                    await loadAccount();
                    setNotice("Your learning data for this course was erased.");
                  });
                }} />
            </section>
          ) : view === "activity" ? (
            <section className="connected-reading-card">
              <h1 data-reading-heading tabIndex={-1}>
                Your learning record
              </h1>
              <p>
                Saved reading, practice, and independent checks. Only verified
                checks count toward completion.
              </p>
              {account && <SupervisionPanel accountId={account.id} enrollment={server} client={supervisionClient} mode="timeline" pending={pending} onRevision={() => refresh(server.enrollmentId)} />}
              {events.map((event) => (
                <div key={event.id}>
                  <p>
                    {(
                      {
                        "block.read": "Reading saved",
                        "assessment.answered": "Check answered",
                        "assessment.submitted": "Check answered",
                        "assessment.issued": "Check started",
                        "episode.placed": "Lesson placed out",
                        "episode.completed": "Lesson completed",
                        "companion.requested": "Companion message saved",
                        "profile.updated": "Learning profile updated",
                      } as Record<string, string>
                    )[event.event_type] ?? "Learning activity saved"}
                  </p>
                  <time dateTime={event.created_at}>
                    {new Date(event.created_at).toLocaleString()}
                  </time>
                </div>
              ))}
            </section>
          ) : !episode && model ? (
            <>
              {policyPanel}
              <ClosureSummary server={server} />
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
              />
              <CourseRoadmap
                course={model.course}
                snapshot={model.snapshot}
                compact={compact}
                onOpenLesson={(lesson) => openEpisode(lesson.id)}
                onPlacement={() => {
                  // The card is shown only while this panel is on screen.
                  const panel = document.getElementById(PLACEMENT_PANEL_ID);
                  panel?.scrollIntoView({ behavior: "smooth", block: "start" });
                  panel?.focus({ preventScroll: true });
                }}
              />
            </>
          ) : null}
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
              policyPanel={policyPanel}
              resources={resourcesClient}
              reviews={reviewsLoader}
              onReviewReply={async (attemptId, text) => { await command(`reviews/${encodeURIComponent(attemptId)}/reply`, { answer: text }); }}
              onReviewAppeal={async (attemptId, reason) => { await command(`reviews/${encodeURIComponent(attemptId)}/appeal`, { reason }); }}
              onAnswerChange={(value) => drafts.write(answerKey, value)}
              onBlockChange={onBlockChange}
              onVisualContextChange={onVisualContextChange}
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
                  setNotice(result.explanation);
                })
              }
              onComplete={completeEpisode}
              onNormal={() => setPlacement(false)}
              onRefresh={() => run(() => refresh(server.enrollmentId))}
            />
            </div>
          )}
        </main>
        {server && account && (
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
                label="Your message"
                shown={drafts.version(draftKey)!}
                other={companionConflict}
                onKeepShown={() => drafts.resolve(draftKey, "shown")}
                onUseOther={() => drafts.resolve(draftKey, "other")}
              />
            )}
            <ConnectedCompanion
              context={context}
              messages={conversation.messages}
              episodeTitles={titles}
              draft={draft}
              onDraftChange={(value) => drafts.write(draftKey, value)}
              onSend={sendCompanion}
              pending={pending}
              loaded={conversation.loaded}
              error={conversation.error}
              storageUnavailable={storageUnavailable || drafts.unavailable}
              unavailable={Boolean(
                episode && server.inaccessibleEpisodeIds.includes(episode.id),
              )}
            />
          </CompanionDock>
        )}
      </div>
    </div>
  );
}
