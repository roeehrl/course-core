/* Usability timings for a study that asked for them (P15; services/api/src/study.ts). Only
 * active while the learner takes part in such a study (the server says so in
 * `studyArm.measuresUsability`, and refuses anything else). Nothing here reads what the learner
 * types or which lesson they are in: a trial is a place code, a duration, a count of other
 * controls used first, and for a detour whether the same place was showing again afterwards.
 *
 * - next_action: starts when a place is shown (the course page, a lesson, a check, or a lesson
 *   just after a detour) and ends when the learner uses that place's required next step: a
 *   control marked data-usability="next". Other buttons and links used first are wrong turns.
 *   After a required step the next trial starts at once in the same place.
 * - detour_return: starts on a control marked data-usability="detour" (the companion, the
 *   "Your course" menu) and ends when a lesson is shown again, or, for a companion beside the
 *   lesson, at the next control used outside it.
 * Leaving the app (the page hidden) ends open trials as abandoned. */

export type UsabilityPlace = "course_page" | "lesson" | "check" | "after_detour";
export type DeviceClass = "phone" | "tablet" | "desktop";
export interface UsabilityTrial {
  kind: "next_action" | "detour_return";
  place: UsabilityPlace;
  deviceClass: DeviceClass;
  outcome: "reached" | "abandoned";
  elapsedMs: number;
  wrongTurns: number;
  contextKept: boolean | null;
}
export type UsabilitySend = (batchId: string, trials: UsabilityTrial[]) => Promise<"ok" | "off">;

/** The longest trial worth keeping; the server refuses more. */
const LIMIT_MS = 3_600_000;
const BATCH = 10;

export function createUsabilityRecorder(options: {
  send: UsabilitySend;
  deviceClass: () => DeviceClass;
  now?: () => number;
  newId?: () => string;
}) {
  const now = options.now ?? (() => performance.now());
  const newId = options.newId ?? (() => crypto.randomUUID());
  // `auto`: started right after a required step, before the app showed what comes next.
  let open: { place: UsabilityPlace; key: string; started: number; wrongTurns: number; auto: boolean } | null = null;
  let detour: { started: number; context: string } | null = null;
  let place: UsabilityPlace | null = null,
    context = "";
  let queue: UsabilityTrial[] = [];
  let stopped = false;
  const elapsed = (started: number) => Math.min(LIMIT_MS, Math.max(0, Math.round(now() - started)));
  function push(trial: Omit<UsabilityTrial, "deviceClass">) {
    if (stopped) return;
    queue.push({ ...trial, deviceClass: options.deviceClass() });
    if (queue.length >= BATCH) void flush();
  }
  function start(at: UsabilityPlace, auto = false) {
    open = { place: at, key: context, started: now(), wrongTurns: 0, auto };
  }
  /** Sends what is queued. A batch keeps its id across a retry, so it is stored once. */
  async function flush() {
    if (stopped || !queue.length) return;
    const trials = queue.slice(0, 50),
      batchId = newId();
    queue = queue.slice(trials.length);
    try {
      if ((await options.send(batchId, trials)) === "off") stopped = true;
    } catch {
      // One retry with the same batch id; then the trials are dropped (they are measures, not records).
      try {
        if ((await options.send(batchId, trials)) === "off") stopped = true;
      } catch {
        /* dropped */
      }
    }
  }
  return {
    /** A place is now on screen. `key` tells places apart (it never leaves the device). */
    shown(next: UsabilityPlace, key: string) {
      if (stopped) return;
      place = next;
      context = key;
      if (detour && next !== "course_page") {
        push({ kind: "detour_return", place: "lesson", outcome: "reached", elapsedMs: elapsed(detour.started), wrongTurns: 0, contextKept: key === detour.context });
        detour = null;
        // What the learner does right after coming back is its own next-step trial (protocol task E).
        start("after_detour");
        return;
      }
      // An unfinished trial continues across navigation: its wrong turns keep counting. One
      // started by the required step itself restarts where that step led.
      if (!open || (open.auto && open.wrongTurns === 0 && (open.place !== next || open.key !== key))) start(next);
    },
    /** A control was used: the place's required step, a detour, or anything else. */
    action(kind: "next" | "detour" | "other") {
      if (stopped) return;
      if (kind === "detour") {
        if (!detour) detour = { started: now(), context };
        return;
      }
      if (detour) {
        // Back without a new lesson being shown (a companion beside it, or the course page): the
        // detour ends at this control; the place is the same if nothing else was shown meanwhile.
        push({ kind: "detour_return", place: "lesson", outcome: "reached", elapsedMs: elapsed(detour.started), wrongTurns: 0, contextKept: context === detour.context });
        detour = null;
      }
      if (!open) return;
      if (kind === "other") {
        open.wrongTurns = Math.min(100, open.wrongTurns + 1);
        return;
      }
      push({ kind: "next_action", place: open.place, outcome: "reached", elapsedMs: elapsed(open.started), wrongTurns: open.wrongTurns, contextKept: null });
      open = null;
      if (place) start(place, true);
    },
    /** The learner left the app: open trials end as abandoned and the queue is sent. */
    hidden() {
      if (open)
        push({ kind: "next_action", place: open.place, outcome: "abandoned", elapsedMs: elapsed(open.started), wrongTurns: open.wrongTurns, contextKept: null });
      if (detour) push({ kind: "detour_return", place: "lesson", outcome: "abandoned", elapsedMs: elapsed(detour.started), wrongTurns: 0, contextKept: false });
      open = null;
      detour = null;
      return flush();
    },
    /** Back in the app: timing restarts where the learner is. */
    visible() {
      if (place && !open) start(place);
    },
    flush,
    /** For tests: what is waiting to be sent. */
    pending: () => [...queue],
  };
}
export type UsabilityRecorder = ReturnType<typeof createUsabilityRecorder>;

/** What a click on `target` means for the open trial. Typing, choosing an answer option and
 * anything inside a region marked data-usability="ignore" (the companion's own controls) is
 * not counted. */
export function classifyClick(target: Element | null): "next" | "detour" | "other" | null {
  if (!target) return null;
  const marked = target.closest<HTMLElement>("[data-usability]")?.dataset.usability;
  if (marked === "ignore") return null;
  if (marked === "next" || marked === "detour") return marked;
  return target.closest('button, a[href], summary, [role="button"], [role="link"], [role="tab"], select') ? "other" : null;
}
