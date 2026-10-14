import React, {
  useCallback,
  useEffect,
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
import { presentation } from "./client/presentation";
import { CourseRoadmap } from "./components/CourseRoadmap";
import { ProfileEditor } from "./components/ProfileEditor";
import { LearnerMemoryPanel } from './components/LearnerMemoryPanel';
import { createMemoryClient } from './client/memoryClient';
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
import { useCompanionConversation } from "./hooks/useCompanionConversation";
import type { Profile } from "./domain/types";
import "./connected/connected.css";
import { codeSubmissionError } from "./connected/code";
import { answerFeedback } from "./connected/answerFeedback";
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
function browserStore(): BrowserStore | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return;
  }
}
export function ConnectedHost({ companionClient }: ConnectedHostProps = {}) {
  const [initialApi] = useState(() => createCourseApi());
  const { width, height, fontScale } = useWindowDimensions(),
    compact = width < 760,
    wide = width / (fontScale || 1) >= 1120 && height >= 620;
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
    [placement, setPlacement] = useState(false);
  const [view, setView] = useState<"learn" | "profile" | "activity">("learn"),
    [companionOpen, setCompanionOpen] = useState(false);
  const [events, setEvents] = useState<
    { id: string; event_type: string; created_at: string }[]
  >([]);
  const [storageUnavailable, setStorageUnavailable] = useState(false),
    [now, setNow] = useState(Date.now());
  const [checkingAnswer, setCheckingAnswer] = useState(false);
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
    Boolean(server && (wide || companionOpen)),
    server?.revision ?? 0,
  );
  const policyClient = useMemo(() => createPolicyClient(api), [api]);
  const memoryClient = useMemo(() => createMemoryClient(api, account?.id ?? 'signed-out'), [api, account?.id]);
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
    () => (server ? presentation(server) : undefined),
    [server],
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
  const answerKey = `${scope}:${challenge?.question.type === "code" ? "code-answer" : "answer"}:${challenge?.challengeId ?? "none"}`,
    draftKey = `${scope}:companion:${episodeId ?? "roadmap"}`;
  const answer = drafts.has(answerKey)
      ? drafts.read(answerKey)
      : challenge?.question.type === "code"
        ? challenge.question.starterCode
        : "",
    draft = drafts.read(draftKey);
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
  useEffect(() => {
    document
      .querySelector<HTMLElement>("[data-reading-heading]")
      ?.focus({ preventScroll: true });
    window.scrollTo?.({ top: 0, behavior: "instant" });
    document.querySelector<HTMLElement>(".connected-main")?.scrollTo?.({top:0,behavior:"instant"});
  }, [episodeId, view]);
  async function refresh(id: string) {
    const value = await api.load(id);
    setServer(value);
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
      setServer(undefined);
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
        cause instanceof CourseApiError
          ? cause.message
          : "The request could not be completed. Your draft is preserved. Please retry.",
      );
      if (cause instanceof CourseApiError && cause.code === "UNAUTHENTICATED") {
        setAccount(undefined);
        setServer(undefined);
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
    const value =
      item.question.type === "numeric" ? Number(answer.trim()) : answer;
    if (
      item.question.type === "numeric" &&
      (!answer.trim() || !Number.isFinite(value))
    ) {
      setError("Enter a finite number.");
      return;
    }
    if (item.question.type === "code") {
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
      }>("answers", { challengeId: item.challengeId, answer: value });
      setNotice(answerFeedback(result, item.question.type === "code"));
    } finally {
      setCheckingAnswer(false);
    }
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
  const [hasRecovery, setHasRecovery] = useState(false);
  useEffect(() => {
    try {
      setHasRecovery(server ? api.hasPending(server.enrollmentId) : false);
    } catch {
      setHasRecovery(false);
    }
  }, [api, server?.enrollmentId, server?.revision, pending, error]);
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
    setServer(undefined);
    setEpisodeId(undefined);
    setCompanionOpen(false);
    run(loadAccount);
  }
  return (
    <div className={`connected-host ${wide ? "" : "is-compact"}`}>
      <header className="connected-header" data-connected-background>
        <div className="connected-header-inner">
          <div className="connected-brand">
            Course Core <span>/ learn</span>
          </div>
          {account && (
            <div className="connected-account">
              <span>{account.displayName}</span>
              {server && (
                <button
                  type="button"
                  onClick={() => setView("profile")}
                  disabled={pending}
                >
                  My profile
                </button>
              )}
              {account.hasPassword && (
                <button
                  type="button"
                  onClick={() => setChangingPassword(true)}
                  disabled={pending || changingPassword}
                >
                  Change password
                </button>
              )}
              {passkeysSupported() && (
                <button
                  type="button"
                  onClick={() => setManagingPasskeys(true)}
                  disabled={pending || managingPasskeys}
                >
                  Passkeys
                </button>
              )}
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  run(async () => {
                    await api.request("/auth/logout", "POST");
                    drafts.clear();
                    setAccount(undefined);
                    setServer(undefined);
                    setEpisodeId(undefined);
                    setCatalog([]);
                    setEnrollments([]);
                    setPreview(undefined);
                    setStartAttempts({});
                    setCompanionOpen(false);
                    setChangingPassword(false);
                    setManagingPasskeys(false);
                    setView("learn");
                  })
                }
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>
      <div
        className={`connected-layout ${server && wide ? "with-companion" : ""}`}
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
              {view === "learn" && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    run(async () => {
                      const result = await api.request<{
                        events: typeof events;
                      }>(
                        `/api/enrollments/${encodeURIComponent(server.enrollmentId)}/events`,
                      );
                      setEvents(result.events);
                      setView("activity");
                    })
                  }
                >
                  Learning record
                </button>
              )}
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
          {hasRecovery && (
            <div className="connected-recovery">
              <p>A saved request still needs confirmation.</p>
              <Button
                label="Retry saved request"
                disabled={pending}
                onPress={() =>
                  server && run(() => refresh(server.enrollmentId))
                }
              />
            </div>
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
              <PersonalChanges api={api} server={server} onChanged={() => void refresh(server.enrollmentId)} />
              <ReviewAssistConsent api={api} server={server} onChanged={() => void refresh(server.enrollmentId)} />
              <YourDataPanel api={api} enrollmentId={server.enrollmentId} courseTitle={server.course.title}
                onErased={() => {
                  setServer(undefined);
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
                command={async (action, data) => {
                  // Sequential placement steps must use the latest revision, not a render-time snapshot.
                  const fresh = await api.load(server.enrollmentId);
                  const result = await api.command<never>(fresh, action, data);
                  await refresh(server.enrollmentId);
                  return result;
                }}
                enrollmentId={server.enrollmentId}
                firstEpisodeId={server.course.chapters[0]?.episodes[0]?.id ?? ""}
                onFinished={() => void refresh(server.enrollmentId)}
              />
              <RetentionPanel
                api={api}
                enrollmentId={server.enrollmentId}
                revision={server.revision}
                onStart={async (objectiveId) => {
                  const fresh = await api.load(server.enrollmentId);
                  const issued = await api.command<{ episodeId: string }>(fresh, "retention/check", { objectiveId });
                  await refresh(server.enrollmentId);
                  openEpisode(issued.episodeId);
                }}
              />
              <CourseRoadmap
                course={model.course}
                snapshot={model.snapshot}
                compact={compact}
                onOpenLesson={(lesson) => openEpisode(lesson.id)}
                onPlacement={() =>
                  document
                    .querySelector(".connected-placement")
                    ?.scrollIntoView({ behavior: "smooth", block: "start" })
                }
              />
            </>
          ) : episode ? (
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
              onStart={() =>
                run(() => {
                  const recovery=server.recovery?.find(r=>r.episodeId===episodeId)?.freshCheck;
                  return recovery&&!placement?command('adaptation/fresh-question',{
                    episodeId,objectiveId:recovery.objectiveId,familyId:recovery.familyId,mode:'independent',expectedPlanRevision:server.planRevision??0,
                  }):command("challenges", {
                    episodeId,
                    mode: placement ? "placement" : "independent",
                  });
                })
              }
              onAnswer={(item) => run(() => submitAnswer(item))}
              onSolution={(item) =>
                run(async () => {
                  const result = await command<{ explanation: string }>(
                    "solution",
                    { challengeId: item.challengeId },
                  );
                  setNotice(result.explanation);
                })
              }
              onComplete={() =>
                run(async () => {
                  await command("complete", {
                    episodeId,
                    ...(placement ? { placement: true } : {}),
                  });
                  setEpisodeId(undefined);
                  setPlacement(false);
                  setNotice(
                    "Your progress is saved. Continue along your learning path.",
                  );
                })
              }
              onNormal={() => setPlacement(false)}
              onRefresh={() => run(() => refresh(server.enrollmentId))}
            />
          ) : null}
        </main>
        {server && account && (
          <CompanionDock
            key={`${account.id}:${server.enrollmentId}`}
            wide={wide}
            open={companionOpen}
            onOpenChange={setCompanionOpen}
          >
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
