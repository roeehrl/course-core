import { evaluate, finite } from "./expression.js";
import { catalogText, visualError } from "./errors.js";
import { createGeometry, flattenNodes, inversePoint } from "./geometry.js";
import {
  assertStateValue,
  deepFreeze,
  LIMITS,
  parseScene,
  preflight,
} from "./schema.js";
import type {
  CheckResult,
  Frame,
  Point,
  Replay,
  ReplayEvent,
  RuntimeOptions,
  Scene,
  State,
  Value,
} from "./types.js";

export interface RuntimeSnapshot {
  frame: Frame;
  playing: boolean;
}
function fingerprint(scene: Scene): string {
  function canonical(v: unknown): string {
    return v && typeof v === "object"
      ? Array.isArray(v)
        ? `[${v.map(canonical).join(",")}]`
        : `{${Object.keys(v)
            .sort()
            .map(
              (k) =>
                `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`,
            )
            .join(",")}}`
      : JSON.stringify(v);
  }
  const data = canonical(scene);
  let a = 2166136261,
    b = 0x9e3779b9;
  for (let i = 0; i < data.length; i++) {
    a = Math.imul(a ^ data.charCodeAt(i), 16777619);
    b = Math.imul(b ^ data.charCodeAt(i), 2246822519);
  }
  return `${data.length}-${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}`;
}
function seedValue(seed: number): number {
  if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295)
    throw visualError("SEED", "seedMustBeUint32");
  return seed;
}
function widthValue(width: number): number {
  finite(width);
  if (width <= 0 || width > 100_000)
    throw visualError("VIEWPORT", "invalidViewportWidth");
  return width;
}

export class VisualRuntime {
  readonly scene: Scene;
  private width: number;
  private reduced: boolean;
  private seed: number;
  private events: ReplayEvent[] = [];
  private listeners = new Set<() => void>();
  private snapshot: RuntimeSnapshot;
  private checks: RuntimeOptions["referenceChecks"];
  private readonly digest: string;
  constructor(input: unknown, options: RuntimeOptions = {}) {
    this.scene = parseScene(input);
    this.digest = fingerprint(this.scene);
    this.width = widthValue(options.viewportWidth ?? 960);
    this.reduced = options.reducedMotion ?? false;
    this.seed = seedValue(options.seed ?? this.scene.simulation?.seed ?? 1);
    this.checks = options.referenceChecks;
    this.snapshot = {
      frame: this.compute(
        this.reduced ? this.scene.accessibility.reducedMotion.atMs : 0,
      ),
      playing: false,
    };
  }
  getSnapshot = (): RuntimeSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(frame: Frame, playing = this.snapshot.playing): void {
    this.snapshot = Object.freeze({ frame, playing });
    for (const listener of this.listeners) listener();
  }
  private compute(
    timeMs: number,
    events = this.events,
    seed = this.seed,
    width = this.width,
    reduced = this.reduced,
  ): Frame {
    const state: Record<string, Value> = Object.fromEntries(
      Object.entries(this.scene.state).map(([key, field]) => [
        key,
        field.initial,
      ]),
    );
    const budget = { remaining: LIMITS.evaluation };
    let cursor = 0;
    const apply = (event: ReplayEvent) => {
      for (const [key, value] of Object.entries(event.changes)) {
        assertStateValue(this.scene.state[key], value);
        state[key] = value;
      }
    };
    const sim = this.scene.simulation;
    if (sim) {
      const ticks = Math.floor(timeMs / sim.stepMs);
      for (let tick = 1; tick <= ticks; tick++) {
        const at = tick * sim.stepMs;
        while (cursor < events.length && events[cursor]!.atMs < at)
          apply(events[cursor++]!);
        const updates: Record<string, Value> = {};
        for (const [key, expression] of Object.entries(sim.updates)) {
          const value = evaluate(expression, {
            state,
            timeMs: at,
            seed,
            tick,
            budget,
          });
          assertStateValue(this.scene.state[key], value);
          updates[key] = value;
        }
        Object.assign(state, updates);
        while (cursor < events.length && events[cursor]!.atMs <= at)
          apply(events[cursor++]!);
      }
    }
    while (cursor < events.length && events[cursor]!.atMs <= timeMs)
      apply(events[cursor++]!);
    return deepFreeze(
      createGeometry(this.scene, state, timeMs, width, reduced, {
        state,
        timeMs,
        seed,
        tick: sim ? Math.floor(timeMs / sim.stepMs) : 0,
        budget,
      }),
    );
  }
  seek(timeMs: number): Frame {
    finite(timeMs);
    const time = Math.max(0, Math.min(this.scene.timeline.durationMs, timeMs));
    const frame = this.compute(time);
    this.publish(frame, this.snapshot.playing && time < frame.durationMs);
    return frame;
  }
  play(): void {
    if (
      this.reduced ||
      this.scene.timeline.durationMs === 0 ||
      this.snapshot.playing
    )
      return;
    const frame =
      this.snapshot.frame.timeMs >= this.scene.timeline.durationMs
        ? this.compute(0)
        : this.snapshot.frame;
    this.publish(frame, true);
  }
  pause(): void {
    if (this.snapshot.playing) this.publish(this.snapshot.frame, false);
  }
  /** Host supplies elapsed milliseconds; no wall clock or timers in the portable engine. */
  advance(deltaMs: number): Frame {
    finite(deltaMs);
    if (deltaMs < 0) throw visualError("TIME", "elapsedTimeCannotBeNegative");
    if (!this.snapshot.playing || this.reduced) return this.snapshot.frame;
    try {
      return this.seek(this.snapshot.frame.timeMs + deltaMs);
    } catch (error) {
      this.pause();
      throw error;
    }
  }
  setViewport(width: number): void {
    widthValue(width);
    const frame = this.compute(
      this.snapshot.frame.timeMs,
      this.events,
      this.seed,
      width,
    );
    this.width = width;
    this.publish(frame);
  }
  setReducedMotion(reduced: boolean): void {
    if (this.reduced === reduced) return;
    const time = reduced
      ? this.scene.accessibility.reducedMotion.atMs
      : this.snapshot.frame.timeMs;
    const frame = this.compute(
      time,
      this.events,
      this.seed,
      this.width,
      reduced,
    );
    this.reduced = reduced;
    this.publish(frame, false);
  }
  setState(changes: Record<string, Value>): Frame {
    preflight(changes);
    if (
      !changes ||
      typeof changes !== "object" ||
      Array.isArray(changes) ||
      !Object.keys(changes).length
    )
      throw visualError("STATE", "expectedStateChanges");
    for (const [key, value] of Object.entries(changes))
      assertStateValue(this.scene.state[key], value);
    const atMs = this.snapshot.frame.timeMs;
    // Editing after a backward seek branches history, discarding only future events.
    const previous = this.events.filter((e) => e.atMs <= atMs);
    const last = previous.at(-1);
    const events =
      last?.atMs === atMs
        ? [
            ...previous.slice(0, -1),
            { atMs, changes: { ...last.changes, ...changes } },
          ]
        : [...previous, { atMs, changes: { ...changes } }];
    if (events.length > LIMITS.replayEvents)
      throw visualError("REPLAY_LIMIT", "tooManyReplayEvents");
    const frame = this.compute(atMs, events);
    this.events = events;
    this.publish(frame);
    return frame;
  }
  reset(): void {
    const frame = this.compute(
      this.reduced ? this.scene.accessibility.reducedMotion.atMs : 0,
      [],
    );
    this.events = [];
    this.publish(frame, false);
  }
  exportReplay(): Replay {
    return deepFreeze({
      version: 1,
      sceneId: this.scene.id,
      sceneFingerprint: this.digest,
      seed: this.seed,
      events: this.events.map((e) => ({
        atMs: e.atMs,
        changes: { ...e.changes },
      })),
    });
  }
  restoreReplay(input: unknown): Frame {
    preflight(input);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw visualError("REPLAY", "invalidReplay");
    const replay = input as Replay;
    if (
      Object.keys(input).some(
        (k) =>
          ![
            "version",
            "sceneId",
            "sceneFingerprint",
            "seed",
            "events",
          ].includes(k),
      ) ||
      replay.version !== 1 ||
      replay.sceneId !== this.scene.id ||
      replay.sceneFingerprint !== this.digest ||
      !Array.isArray(replay.events) ||
      replay.events.length > LIMITS.replayEvents
    )
      throw visualError("REPLAY", "replaySceneMismatch");
    seedValue(replay.seed);
    let previous = -1;
    for (const event of replay.events) {
      if (
        !event ||
        Object.keys(event).some((k) => !["atMs", "changes"].includes(k)) ||
        typeof event.atMs !== "number" ||
        !Number.isFinite(event.atMs) ||
        event.atMs < previous ||
        event.atMs < 0 ||
        event.atMs > this.scene.timeline.durationMs ||
        !event.changes ||
        typeof event.changes !== "object" ||
        Array.isArray(event.changes) ||
        !Object.keys(event.changes).length
      )
        throw visualError("REPLAY", "invalidReplayEvent");
      previous = event.atMs;
      for (const [key, value] of Object.entries(event.changes))
        assertStateValue(this.scene.state[key], value);
    }
    const events = replay.events.map((e) => ({
      atMs: e.atMs,
      changes: { ...e.changes },
    }));
    const frame = this.compute(this.snapshot.frame.timeMs, events, replay.seed);
    this.events = events;
    this.seed = replay.seed;
    this.publish(frame, false);
    return frame;
  }
  manipulatePointer(id: string, world: Point): void {
    finite(world.x);
    finite(world.y);
    const node = flattenNodes(this.snapshot.frame.nodes).find(
      (n) => n.id === id,
    );
    if (!node?.manipulate || !node.visible) return;
    const local = inversePoint(node.parentMatrix, world),
      changes: Record<string, Value> = {};
    for (const axis of ["x", "y"] as const) {
      const binding = node.manipulate[axis];
      if (!binding) continue;
      const field = this.scene.state[binding.state]!;
      if (field.kind !== "number") continue;
      const ratio = Math.max(
        0,
        Math.min(1, (local[axis] - binding.from) / (binding.to - binding.from)),
      );
      const value =
        field.min +
        Math.round((ratio * (field.max - field.min)) / field.step) * field.step;
      changes[binding.state] = Math.max(
        field.min,
        Math.min(field.max, Number(value.toFixed(10))),
      );
    }
    if (Object.keys(changes).length) this.setState(changes);
  }
  manipulateKey(id: string, key: string, shift = false): boolean {
    const node = flattenNodes(this.snapshot.frame.nodes).find(
      (n) => n.id === id,
    );
    if (!node?.manipulate || !node.visible) return false;
    const action = node.manipulate;
    if ((key === "Enter" || key === " ") && action.activate) {
      this.setState({ [action.activate.state]: action.activate.value });
      return true;
    }
    const binding =
      key === "ArrowUp" || key === "ArrowDown"
        ? (action.y ?? action.x)
        : (action.x ?? action.y);
    if (
      !binding ||
      ![
        "ArrowRight",
        "ArrowLeft",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
      ].includes(key)
    )
      return false;
    const field = this.scene.state[binding.state]!;
    if (field.kind !== "number") return false;
    const current = this.snapshot.frame.state[binding.state] as number;
    const direction = key === "ArrowRight" || key === "ArrowUp" ? 1 : -1;
    const next =
      key === "Home"
        ? field.min
        : key === "End"
          ? field.max
          : current + direction * field.step * (shift ? 10 : 1);
    this.setState({
      [binding.state]: Math.max(
        field.min,
        Math.min(field.max, Number(next.toFixed(10))),
      ),
    });
    return true;
  }
  runReferenceChecks(): CheckResult[] {
    return (this.scene.referenceChecks ?? []).map((id) => {
      const check =
        this.checks && Object.hasOwn(this.checks, id)
          ? this.checks[id]
          : undefined;
      if (!check)
        return {
          id,
          passed: false,
          ...catalogText("referenceCheckNotRegistered"),
        };
      try {
        const result = check(this.snapshot.frame);
        return { id, passed: result.passed === true, message: result.message };
      } catch {
        return {
          id,
          passed: false,
          ...catalogText("referenceCheckFailed"),
        };
      }
    });
  }
}
/** Convenient stateless adapter; no DOM, React, timers, or platform APIs. */
export function evaluateScene(
  scene: unknown,
  options: RuntimeOptions & { timeMs?: number; replay?: Replay } = {},
): Frame {
  const runtime = new VisualRuntime(scene, options);
  if (options.replay) runtime.restoreReplay(options.replay);
  return options.timeMs === undefined
    ? runtime.getSnapshot().frame
    : runtime.seek(options.timeMs);
}
