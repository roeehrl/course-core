import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { visualMessages } from "./messages.js";
import { VisualRuntimePlayer } from "./react.js";
import type { VisualRuntimePlayerProps } from "./react.js";
import { VisualRuntime } from "./runtime.js";
import type { Replay, RuntimeOptions } from "./types.js";

export interface LazyVisualPlayerProps
  extends Omit<VisualRuntimePlayerProps, "runtime"> {
  scene: unknown;
  options?: Omit<RuntimeOptions, "reducedMotion">;
  /** The player loads when it comes within this margin of the area it scrolls in. */
  rootMargin?: string;
  /**
   * The element the player scrolls in. By default the nearest ancestor that scrolls
   * vertically (overflow-y auto, scroll or overlay), or the viewport when there is none.
   * `null` always uses the viewport.
   */
  scrollRoot?: Element | null;
  /** A loaded player this long out of that margin is disposed (0 keeps it). */
  disposeAfterMs?: number;
  /** Load now and keep loaded, wherever the player is (e.g. while a debug tool inspects it). */
  eager?: boolean;
  /** Shown before the player loads, e.g. the scene's text alternative (host content). */
  placeholder?: ReactNode;
  /** The live runtime when it is created, and null when it is disposed. */
  onRuntime?: (runtime: VisualRuntime | null) => void;
}

/**
 * A player that parses its scene and creates its runtime only when it nears the viewport,
 * and disposes of the runtime (unmounted, paused, released) after it has stayed far away
 * for `disposeAfterMs` (0.5). Its state survives: the replay and time are kept and restored
 * when it loads again, and completion is never reported twice. Until it loads, a
 * placeholder holds the player's last height, so the page does not jump, and a button
 * loads it at once (for keyboard and screen-reader users who reach it without scrolling).
 * Without IntersectionObserver it loads immediately; `eager` loads it and keeps it loaded.
 * The observer's root is the container the player scrolls in (see `scrollRoot`), so the
 * margin preloads it ahead of that container's visible area, not only the viewport's.
 */
export function LazyVisualPlayer({
  scene,
  options,
  rootMargin = "600px 0px",
  scrollRoot,
  disposeAfterMs = 60_000,
  eager = false,
  placeholder,
  onRuntime,
  onComplete,
  completed,
  onError,
  fallback,
  ...props
}: LazyVisualPlayerProps) {
  const m = visualMessages(props.messages);
  const box = useRef<HTMLDivElement>(null);
  const saved = useRef<{ scene: unknown; replay: Replay; timeMs: number }>(
    null,
  );
  const done = useRef(Boolean(completed));
  if (completed) done.current = true;
  const [near, setNear] = useState(false);
  const [active, setActive] = useState(false);
  const [height, setHeight] = useState<number>();
  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const root = scrollRoot === undefined ? scrollContainer(el) : scrollRoot;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry) setNear(entry.isIntersecting);
      },
      { root, rootMargin },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [rootMargin, scrollRoot]);
  useEffect(() => {
    if (near || eager) {
      setActive(true);
      return;
    }
    if (!active || disposeAfterMs <= 0) return;
    const timer = setTimeout(() => {
      // Keep the player's height for the placeholder, so the page does not move.
      const rect = box.current?.getBoundingClientRect();
      if (rect?.height) setHeight(rect.height);
      setActive(false);
    }, disposeAfterMs);
    return () => clearTimeout(timer);
  }, [near, eager, active, disposeAfterMs]);
  const { viewportWidth, seed, referenceChecks } = options ?? {};
  const created = useMemo(() => {
    if (!active) return undefined;
    let runtime: VisualRuntime;
    try {
      runtime = new VisualRuntime(scene, {
        viewportWidth,
        seed,
        referenceChecks,
      });
    } catch (error) {
      return {
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
    const previous = saved.current;
    if (previous && previous.scene === scene)
      try {
        runtime.restoreReplay(previous.replay);
        runtime.seek(previous.timeMs);
      } catch {
        runtime.reset();
      }
    return { runtime };
  }, [active, scene, viewportWidth, seed, referenceChecks]);
  const onRuntimeRef = useRef(onRuntime);
  onRuntimeRef.current = onRuntime;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  useEffect(() => {
    if (created?.error) onErrorRef.current?.(created.error);
    const runtime = created?.runtime;
    if (!runtime) return;
    onRuntimeRef.current?.(runtime);
    return () => {
      saved.current = {
        scene,
        replay: runtime.exportReplay(),
        timeMs: runtime.getSnapshot().frame.timeMs,
      };
      // Unmounting the player drops its subscriptions and animation frame; pausing
      // stops playback, so nothing keeps the runtime alive once this reference goes.
      runtime.pause();
      onRuntimeRef.current?.(null);
    };
  }, [created, scene]);
  const runtime = created?.runtime;
  return (
    <div
      ref={box}
      className="ccv-lazy"
      data-lazy={runtime ? "loaded" : "waiting"}
      style={!runtime && height ? { minHeight: height } : undefined}
    >
      {runtime ? (
        <VisualRuntimePlayer
          {...props}
          runtime={runtime}
          fallback={fallback}
          onError={onError}
          completed={done.current}
          onComplete={(completion) => {
            done.current = true;
            onComplete?.(completion);
          }}
        />
      ) : created?.error ? (
        <section className="ccv-player" role="alert">
          {fallback ?? <p>{m.invalidScene}</p>}
        </section>
      ) : (
        <section className="ccv-player ccv-lazy-placeholder" aria-busy="true">
          {placeholder ?? <p>{m.lazyPlaceholder}</p>}
          <button type="button" onClick={() => setActive(true)}>
            {m.lazyLoad}
          </button>
        </section>
      )}
    </div>
  );
}

/**
 * The nearest ancestor that scrolls vertically, or null (the viewport). Without it as the
 * observer's root, a margin around the viewport never reaches content clipped by a
 * scrolling container, so the player would load only once it was already visible.
 */
export function scrollContainer(element: Element): Element | null {
  const view = element.ownerDocument?.defaultView;
  if (!view) return null;
  const top = element.ownerDocument.scrollingElement;
  for (
    let node = element.parentElement, depth = 0;
    node && depth < 64;
    node = node.parentElement, depth++
  ) {
    if (node === top || node === element.ownerDocument.body) return null;
    const overflow = view.getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll" || overflow === "overlay")
      return node;
  }
  return null;
}
