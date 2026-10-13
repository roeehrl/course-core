import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  CSSProperties,
  KeyboardEvent,
  PointerEvent,
  ReactNode,
} from "react";
import { flattenNodes } from "./geometry.js";
import { VisualRuntime } from "./runtime.js";
import type { Frame, GeometryNode, RuntimeOptions, Value } from "./types.js";

export interface SceneViewProps {
  frame: Frame;
  title: string;
  className?: string;
  onPointer?: (id: string, point: { x: number; y: number }) => void;
  onKey?: (id: string, key: string, shift: boolean) => boolean;
}
/** Pure SVG view; all geometry/state comes from the portable adapter. */
export function SceneView({
  frame,
  title,
  className,
  onPointer,
  onKey,
}: SceneViewProps) {
  const uid = `visual-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`,
    nodes = flattenNodes(frame.nodes).filter((n) => n.kind !== "group");
  const drag = useRef<{ id: string; pointer: number } | null>(null);
  const convert = (event: PointerEvent<SVGElement>, id: string) => {
    const svg = event.currentTarget.ownerSVGElement,
      matrix = svg?.getScreenCTM();
    if (!svg || !matrix) return;
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const p = point.matrixTransform(matrix.inverse());
    onPointer?.(id, { x: p.x, y: p.y });
  };
  function content(n: GeometryNode): ReactNode {
    switch (n.kind) {
      case "group":
        return (
          <>
            {n.manipulate && (
              <rect
                {...n.bounds}
                fill="transparent"
                stroke="none"
                pointerEvents="all"
              />
            )}
            {n.children?.map(renderNode)}
          </>
        );
      case "rect":
        return <rect width={n.width} height={n.height} rx={n.cornerRadius} />;
      case "circle":
        return <circle r={n.radius} />;
      case "ellipse":
        return <ellipse rx={n.width / 2} ry={n.height / 2} />;
      case "line":
        return (
          <line
            x2={n.x2}
            y2={n.y2}
            pathLength={1}
            strokeDasharray={n.progress < 1 ? `${n.progress} 1` : undefined}
          />
        );
      case "text":
        return (
          <text
            fontSize={n.fontSize}
            fontWeight={n.weight}
            textAnchor={n.align}
          >
            {n.text}
          </text>
        );
      case "plot":
      case "path":
      case "link":
        return (
          <path
            d={n.path}
            pathLength={1}
            strokeDasharray={n.progress < 1 ? `${n.progress} 1` : undefined}
            markerEnd={
              n.arrow && n.progress === 1
                ? `url(#${uid}-arrow-${n.id})`
                : undefined
            }
          />
        );
      default:
        return null;
    }
  }
  function renderNode(n: GeometryNode): ReactNode {
    if (!n.visible) return null;
    const interactive = Boolean(n.manipulate && (onPointer || onKey));
    const keyboard = (event: KeyboardEvent<SVGGElement>) => {
      if (onKey?.(n.id, event.key, event.shiftKey)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    return (
      <g
        key={n.id}
        data-node-id={n.id}
        transform={
          n.kind === "group" ? undefined : `matrix(${n.matrix.join(" ")})`
        }
        opacity={n.kind === "group" ? undefined : n.opacity}
        fill={typeof n.fill === "string" ? n.fill : `url(#${uid}-fill-${n.id})`}
        stroke={
          n.progress === 0 && ["path", "line", "link"].includes(n.kind)
            ? "none"
            : n.stroke
        }
        strokeWidth={n.strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        tabIndex={interactive ? 0 : undefined}
        role={
          interactive
            ? n.manipulate?.activate && !n.manipulate.x && !n.manipulate.y
              ? "button"
              : "group"
            : undefined
        }
        aria-label={
          interactive
            ? `${n.label}. ${n.manipulate?.x || n.manipulate?.y ? "Use arrow keys; Home and End set limits. Shift changes by ten steps." : ""}`
            : undefined
        }
        className={interactive ? "ccv-handle" : undefined}
        onKeyDown={interactive ? keyboard : undefined}
        onClick={
          interactive && n.manipulate?.activate
            ? (event) => {
                event.stopPropagation();
                onKey?.(n.id, "Enter", false);
              }
            : undefined
        }
        onPointerDown={
          interactive && (n.manipulate?.x || n.manipulate?.y)
            ? (event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.focus();
                event.currentTarget.setPointerCapture(event.pointerId);
                drag.current = { id: n.id, pointer: event.pointerId };
                convert(event, n.id);
              }
            : undefined
        }
        onPointerMove={
          interactive
            ? (event) => {
                if (
                  drag.current?.id === n.id &&
                  drag.current.pointer === event.pointerId
                )
                  convert(event, n.id);
              }
            : undefined
        }
        onPointerUp={
          interactive
            ? (event) => {
                if (drag.current?.pointer === event.pointerId) {
                  drag.current = null;
                  if (event.currentTarget.hasPointerCapture(event.pointerId))
                    event.currentTarget.releasePointerCapture(event.pointerId);
                }
              }
            : undefined
        }
        onPointerCancel={
          interactive
            ? () => {
                drag.current = null;
              }
            : undefined
        }
        onLostPointerCapture={
          interactive
            ? () => {
                drag.current = null;
              }
            : undefined
        }
      >
        {interactive && n.label && <title>{n.label}</title>}
        {content(n)}
      </g>
    );
  }
  return (
    <svg
      className={`ccv-scene ${className ?? ""}`}
      viewBox={`0 0 ${frame.width} ${frame.height}`}
      role="group"
      aria-labelledby={`${uid}-title`}
      aria-describedby={`${uid}-description`}
      data-layout={frame.layout}
      style={{ aspectRatio: `${frame.width}/${frame.height}` }}
    >
      <title id={`${uid}-title`}>{title}</title>
      <desc id={`${uid}-description`}>{frame.text}</desc>
      <defs>
        {nodes.map((n) => (
          <g key={n.id}>
            {typeof n.fill !== "string" && (
              <linearGradient
                id={`${uid}-fill-${n.id}`}
                x1="0"
                y1="0"
                x2="1"
                y2="1"
              >
                <stop stopColor={n.fill.from} />
                <stop offset="1" stopColor={n.fill.to} />
              </linearGradient>
            )}
            {n.arrow && (
              <marker
                id={`${uid}-arrow-${n.id}`}
                markerWidth="8"
                markerHeight="8"
                refX="7"
                refY="4"
                orient="auto"
                markerUnits="strokeWidth"
              >
                <path d="M0 0 L8 4 L0 8 Z" fill={n.stroke} />
              </marker>
            )}
          </g>
        ))}
      </defs>
      {frame.nodes.map(renderNode)}
    </svg>
  );
}
export interface VisualRuntimePlayerProps {
  runtime: VisualRuntime;
  className?: string;
  style?: CSSProperties;
  reducedMotion?: boolean;
  onFrame?: (frame: Frame) => void;
  onError?: (error: Error) => void;
  /** Trusted React fallback provided by the embedding app, never scene JSON. */
  fallback?: ReactNode;
}
export interface VisualPlayerProps
  extends Omit<VisualRuntimePlayerProps, "runtime"> {
  scene: unknown;
  options?: Omit<RuntimeOptions, "reducedMotion">;
}
function useReducedMotion(override: boolean | undefined): boolean {
  const subscribe = useCallback((change: () => void) => {
    if (typeof window === "undefined" || !window.matchMedia) return () => {};
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  const snapshot = useCallback(
    () =>
      override ??
      (typeof window !== "undefined" &&
        Boolean(
          window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
        )),
    [override],
  );
  return useSyncExternalStore(subscribe, snapshot, () => override ?? true);
}
export function VisualPlayer({
  scene,
  options,
  fallback,
  ...props
}: VisualPlayerProps) {
  const { viewportWidth, seed, referenceChecks } = options ?? {};
  const created = useMemo(() => {
    try {
      return {
        runtime: new VisualRuntime(scene, {
          viewportWidth,
          seed,
          referenceChecks,
        }),
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error : new Error("Invalid visual"),
      };
    }
  }, [scene, viewportWidth, seed, referenceChecks]);
  useEffect(() => {
    if (created.error) props.onError?.(created.error);
  }, [created, props.onError]);
  if (!created.runtime)
    return (
      <section className={`ccv-player ${props.className ?? ""}`} role="alert">
        {fallback ?? (
          <p>
            This visual could not be displayed. Its scene data failed
            validation.
          </p>
        )}
      </section>
    );
  return (
    <VisualRuntimePlayer
      {...props}
      runtime={created.runtime}
      fallback={fallback}
    />
  );
}
export function VisualRuntimePlayer({
  runtime,
  className,
  style,
  reducedMotion,
  onFrame,
  onError,
  fallback,
}: VisualRuntimePlayerProps) {
  const snapshot = useSyncExternalStore(
      runtime.subscribe,
      runtime.getSnapshot,
      runtime.getSnapshot,
    ),
    { frame, playing } = snapshot;
  const reduced = useReducedMotion(reducedMotion),
    container = useRef<HTMLElement>(null),
    uid = useId();
  const [error, setError] = useState<Error | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const safely = useCallback(
    (action: () => void) => {
      try {
        action();
        setError(null);
      } catch (cause) {
        const e =
          cause instanceof Error
            ? cause
            : new Error("Visual evaluation failed");
        runtime.pause();
        setError(e);
        onErrorRef.current?.(e);
      }
    },
    [runtime],
  );
  useEffect(() => {
    setError(null);
    safely(() => runtime.setReducedMotion(reduced));
  }, [runtime, reduced, safely]);
  useEffect(() => {
    const el = container.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // Apply the width on the next frame, and only when it changed: resizing
    // inside the observer callback re-triggers it (a ResizeObserver loop).
    let frame = 0,
      last = 0;
    const observer = new ResizeObserver((entries) => {
      const width = Math.round(entries[0]?.contentRect.width ?? 0);
      if (width <= 0 || width === last) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        last = width;
        safely(() => runtime.setViewport(width));
      });
    });
    observer.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [runtime, safely]);
  useEffect(() => {
    onFrame?.(frame);
  }, [frame, onFrame]);
  useEffect(() => {
    if (!playing || reduced) return;
    let id = 0,
      previous: number | undefined;
    const tick = (now: number) => {
      if (previous !== undefined) {
        const delta = Math.min(now - previous, 100);
        safely(() => runtime.advance(delta));
      }
      previous = now;
      if (runtime.getSnapshot().playing) id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    const visibility = () => {
      if (document.hidden) runtime.pause();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [runtime, playing, reduced, safely]);
  const change = (key: string, value: Value) =>
    safely(() => {
      runtime.setState({ [key]: value });
    });
  const duration = frame.durationMs;
  return (
    <section
      ref={container}
      className={`ccv-player ${className ?? ""}`}
      style={style}
      aria-label={runtime.scene.title}
      data-reduced-motion={reduced}
    >
      <header className="ccv-heading">
        <div>
          <span className="ccv-eyebrow">
            INTERACTIVE STUDY <span aria-hidden="true">/</span>{" "}
            {frame.layout === "compact" ? "COMPACT" : "EXPANDED"}
          </span>
          <h2>{runtime.scene.title}</h2>
          <p>{runtime.scene.description}</p>
        </div>
        <span className="ccv-badge">
          <span /> {reduced ? "Still mode" : "Live canvas"}
        </span>
      </header>
      {error && (
        <div className="ccv-error" role="alert">
          {fallback ??
            "This step could not be displayed. The last valid frame is preserved. Reset to try again."}
        </div>
      )}
      <div className="ccv-stage">
        <SceneView
          frame={frame}
          title={runtime.scene.title}
          onPointer={(id, point) =>
            safely(() => runtime.manipulatePointer(id, point))
          }
          onKey={(id, key, shift) => {
            let handled = false;
            safely(() => {
              handled = runtime.manipulateKey(id, key, shift);
            });
            return handled;
          }}
        />
      </div>
      <div className="ccv-cue" aria-live={playing ? "off" : "polite"}>
        <span aria-hidden="true">↳</span>{" "}
        {frame.cue || runtime.scene.accessibility.text}
      </div>
      <div className="ccv-toolbar">
        <button
          type="button"
          className="ccv-play"
          disabled={reduced || duration === 0}
          onClick={() =>
            safely(() => (playing ? runtime.pause() : runtime.play()))
          }
          aria-label={playing ? "Pause animation" : "Play animation"}
        >
          {playing ? "Ⅱ" : "▶"}
          <span>{playing ? "Pause" : "Play"}</span>
        </button>
        <div className="ccv-timeline">
          <label htmlFor={`${uid}-time`}>
            Timeline{" "}
            <output aria-live="off">
              {(frame.timeMs / 1000).toFixed(1)} /{" "}
              {(duration / 1000).toFixed(1)} s
            </output>
          </label>
          <input
            id={`${uid}-time`}
            aria-label="Timeline"
            type="range"
            min={0}
            max={duration}
            step={10}
            value={frame.timeMs}
            disabled={duration === 0}
            onChange={(e) =>
              safely(() => {
                runtime.pause();
                runtime.seek(Number(e.target.value));
              })
            }
            aria-valuetext={`${(frame.timeMs / 1000).toFixed(1)} seconds. ${frame.cue}`}
          />
        </div>
        <button
          type="button"
          className="ccv-reset"
          onClick={() => safely(() => runtime.reset())}
        >
          Reset
        </button>
      </div>
      {(runtime.scene.controls?.length ?? 0) > 0 && (
        <fieldset className="ccv-controls">
          <legend>Explore the state</legend>
          {runtime.scene.controls!.map((key) => {
            const field = runtime.scene.state[key]!,
              value = frame.state[key]!;
            return (
              <label
                className={`ccv-control ccv-control-${field.kind}`}
                key={key}
                htmlFor={`${uid}-${key}`}
              >
                <span>
                  {field.label}
                  {field.kind === "number" && (
                    <output aria-live="off">
                      {typeof value === "number"
                        ? Number(value.toFixed(2))
                        : value}
                    </output>
                  )}
                </span>
                {field.kind === "number" ? (
                  <input
                    id={`${uid}-${key}`}
                    aria-label={field.label}
                    type="range"
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    value={value as number}
                    onChange={(e) => change(key, Number(e.target.value))}
                  />
                ) : field.kind === "boolean" ? (
                  <input
                    id={`${uid}-${key}`}
                    aria-label={field.label}
                    type="checkbox"
                    checked={value as boolean}
                    onChange={(e) => change(key, e.target.checked)}
                  />
                ) : (
                  <select
                    id={`${uid}-${key}`}
                    aria-label={field.label}
                    value={value as string}
                    onChange={(e) => change(key, e.target.value)}
                  >
                    {field.options.map((option) => (
                      <option key={option}>{option}</option>
                    ))}
                  </select>
                )}
              </label>
            );
          })}
        </fieldset>
      )}
      <details className="ccv-text" open={reduced}>
        <summary>
          Text equivalent {reduced && "· reduced motion enabled"}
        </summary>
        <p aria-live="off">{frame.text}</p>
        <ol>
          {runtime.scene.timeline.cues.map((cue, i) => (
            <li key={i}>
              <time>{(cue.atMs / 1000).toFixed(1)} s</time>
              {cue.text}
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}
