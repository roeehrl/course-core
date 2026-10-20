import type { VisualRuntime } from "./runtime.js";

/**
 * Pauses a playing runtime while its view is off-screen and resumes it when the view
 * returns, unless the viewer prefers reduced motion or took control in between (play,
 * pause, seek or reset call `cancel`). A runtime the viewer paused stays paused. Hosts feed
 * it IntersectionObserver results; it holds no timers or DOM references.
 */
export class OffscreenPause {
  private pending = false;
  constructor(private readonly runtime: VisualRuntime) {}
  /** True while playback is suspended because the view is off-screen. */
  get suspended(): boolean {
    return this.pending;
  }
  update(visible: boolean, reducedMotion: boolean): void {
    if (!visible) {
      if (this.runtime.getSnapshot().playing) {
        this.runtime.pause();
        this.pending = true;
      }
      return;
    }
    if (!this.pending) return;
    this.pending = false;
    if (!reducedMotion) this.runtime.play();
  }
  cancel(): void {
    this.pending = false;
  }
}
