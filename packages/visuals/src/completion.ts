import type { VisualRuntime } from "./runtime.js";
import type { Frame } from "./types.js";

/** A visual's completion: the viewer reached the end of its timeline (0.5). */
export interface VisualCompletion {
  sceneId: string;
  /** The runtime's scene fingerprint, so a host can tell scene revisions apart. */
  sceneFingerprint: string;
  durationMs: number;
}

/**
 * Emits completion at most once: the first time a frame at the end of the timeline is
 * shown, whether reached by playback or by scrubbing. Replaying, scrubbing back and forth,
 * resetting and restoring a replay never emit again. A scene without a timeline (duration
 * 0) never completes. Completion is an observation for the host to record; it grants
 * nothing. The latch holds no timers or DOM references.
 */
export class CompletionLatch {
  private done: boolean;
  constructor(
    private readonly runtime: VisualRuntime,
    private readonly emit: (completion: VisualCompletion) => void,
    alreadyCompleted = false,
  ) {
    this.done = alreadyCompleted;
  }
  /** True once completion was emitted (or the host said it already was). */
  get completed(): boolean {
    return this.done;
  }
  /** The host recorded completion elsewhere: never emit. */
  markCompleted(): void {
    this.done = true;
  }
  /** Feeds a shown frame; returns true when this call emitted completion. */
  observe(frame: Frame): boolean {
    if (this.done || frame.durationMs === 0 || frame.timeMs < frame.durationMs)
      return false;
    this.done = true;
    this.emit(
      Object.freeze({
        sceneId: frame.sceneId,
        sceneFingerprint: this.runtime.exportReplay().sceneFingerprint,
        durationMs: frame.durationMs,
      }),
    );
    return true;
  }
}
