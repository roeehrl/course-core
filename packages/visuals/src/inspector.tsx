import { useId, useMemo, useState, useSyncExternalStore } from "react";
import { frameAtWidth, runSceneChecks } from "./checks.js";
import type { CheckFailure } from "./checks.js";
import { sceneFeatures } from "./features.js";
import { flattenNodes } from "./geometry.js";
import { SceneView, layoutLabel } from "./react.js";
import type { VisualRuntime } from "./runtime.js";
import type { Value } from "./types.js";

const PROPERTIES = [
  "x",
  "y",
  "rotation",
  "scale",
  "opacity",
  "width",
  "height",
  "radius",
  "fontSize",
  "x2",
  "y2",
  "progress",
] as const;
const round = (n: number) => Number(n.toFixed(3));

/**
 * A design-time parameter inspector for a runtime: every state field (not only the
 * scene's controls), the timeline with jumps to each keyframe, the computed properties of
 * a selected node, and the scene's publish-time checks. It drives the same runtime as the
 * player beside it. A tool for authors; it grants nothing and records nothing.
 */
export function VisualInspector({ runtime }: { runtime: VisualRuntime }) {
  const { frame } = useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
    runtime.getSnapshot,
  );
  const uid = `ccvi-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const scene = runtime.scene;
  const nodes = flattenNodes(frame.nodes);
  const [selected, setSelected] = useState(nodes[0]?.id ?? "");
  const [checks, setChecks] = useState<CheckFailure[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const node = nodes.find((n) => n.id === selected);
  const keyframes = useMemo(
    () =>
      [
        ...new Set(
          [
            ...scene.timeline.tracks.flatMap((t) =>
              t.keyframes.map((k) => k.atMs),
            ),
            ...(scene.timeline.staggers ?? []).flatMap((s) =>
              s.nodes.flatMap((_, i) =>
                s.keyframes.map((k) => k.atMs + i * s.delayMs),
              ),
            ),
          ].filter((t) => t <= scene.timeline.durationMs),
        ),
      ]
        .sort((a, b) => a - b)
        .slice(0, 24),
    [scene],
  );
  const act = (action: () => void) => {
    try {
      action();
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Change refused");
    }
  };
  const set = (key: string, value: Value) =>
    act(() => runtime.setState({ [key]: value }));
  const counts = {
    invariants: scene.invariants?.length ?? 0,
    goldens: scene.goldens?.length ?? 0,
  };
  return (
    <section className="ccv-inspector" aria-labelledby={`${uid}-title`}>
      <h2 id={`${uid}-title`}>Inspector · {scene.title}</h2>
      <dl className="ccv-inspector-summary">
        <dt>Scene</dt>
        <dd>{scene.id}</dd>
        <dt>Layout</dt>
        <dd>
          {layoutLabel(frame.layout)} · {frame.width} × {frame.height}
        </dd>
        <dt>Time</dt>
        <dd>{(frame.timeMs / 1000).toFixed(2)} s</dd>
        <dt>Features</dt>
        <dd>{sceneFeatures(scene).join(", ") || "none"}</dd>
      </dl>
      {error && (
        <p className="ccv-inspector-error" role="alert">
          {error}
        </p>
      )}
      {Object.keys(scene.state).length > 0 && (
        <fieldset className="ccv-inspector-group">
          <legend>Parameters</legend>
          {Object.entries(scene.state).map(([key, field]) => {
            const id = `${uid}-state-${key}`,
              value = frame.state[key]!;
            return (
              <div className="ccv-inspector-field" key={key}>
                <label htmlFor={id}>
                  {field.label} <code>{key}</code>
                </label>
                {field.kind === "number" ? (
                  <input
                    id={id}
                    type="number"
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    value={value as number}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (e.target.value !== "" && Number.isFinite(n))
                        set(key, n);
                    }}
                  />
                ) : field.kind === "boolean" ? (
                  <input
                    id={id}
                    type="checkbox"
                    checked={value as boolean}
                    onChange={(e) => set(key, e.target.checked)}
                  />
                ) : (
                  <select
                    id={id}
                    value={value as string}
                    onChange={(e) => set(key, e.target.value)}
                  >
                    {field.options.map((option) => (
                      <option key={option}>{option}</option>
                    ))}
                  </select>
                )}
              </div>
            );
          })}
        </fieldset>
      )}
      <fieldset className="ccv-inspector-group">
        <legend>Timeline</legend>
        <label htmlFor={`${uid}-time`}>Inspector time</label>
        <input
          id={`${uid}-time`}
          type="range"
          min={0}
          max={frame.durationMs}
          step={10}
          value={frame.timeMs}
          disabled={frame.durationMs === 0}
          onChange={(e) =>
            act(() => {
              runtime.pause();
              runtime.seek(Number(e.target.value));
            })
          }
        />
        {keyframes.length > 0 && (
          <ul className="ccv-inspector-keyframes" aria-label="Keyframes">
            {keyframes.map((t) => (
              <li key={t}>
                <button
                  type="button"
                  aria-pressed={frame.timeMs === t}
                  onClick={() =>
                    act(() => {
                      runtime.pause();
                      runtime.seek(t);
                    })
                  }
                >
                  {(t / 1000).toFixed(2)} s
                </button>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      <section className="ccv-inspector-group" aria-labelledby={`${uid}-node`}>
        <h3 id={`${uid}-node`}>Node</h3>
        <label htmlFor={`${uid}-node-select`}>Selected node</label>
        <select
          id={`${uid}-node-select`}
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.id} ({n.kind})
            </option>
          ))}
        </select>
        {node && (
          <table className="ccv-inspector-table">
            <caption>Computed properties of {node.id}</caption>
            <tbody>
              <tr>
                <th scope="row">visible</th>
                <td>{String(node.visible)}</td>
              </tr>
              {PROPERTIES.map((p) => (
                <tr key={p}>
                  <th scope="row">{p}</th>
                  <td>{round(node[p])}</td>
                </tr>
              ))}
              <tr>
                <th scope="row">bounds</th>
                <td>
                  {round(node.bounds.x)}, {round(node.bounds.y)},{" "}
                  {round(node.bounds.width)} × {round(node.bounds.height)}
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </section>
      <section
        className="ccv-inspector-group"
        aria-labelledby={`${uid}-checks`}
      >
        <h3 id={`${uid}-checks`}>Publish checks</h3>
        <p>
          {counts.invariants} invariants, {counts.goldens} goldens.
        </p>
        <button
          type="button"
          onClick={() => act(() => setChecks(runSceneChecks(scene)))}
        >
          Run checks
        </button>
        <div role="status">
          {checks &&
            (checks.length === 0 ? (
              <p className="ccv-inspector-pass">
                All checks pass at every layout.
              </p>
            ) : (
              <ul className="ccv-inspector-failures">
                {checks.slice(0, 20).map((f, i) => (
                  <li key={i}>
                    {f.check} <code>{f.id}</code> · {layoutLabel(f.layout)} ·{" "}
                    {f.atMs} ms: {f.message}
                  </li>
                ))}
              </ul>
            ))}
        </div>
      </section>
    </section>
  );
}

export interface PreviewDevice {
  name: string;
  width: number;
}
/** One device per layout mode of the four-layout set. */
export const PREVIEW_DEVICES: readonly PreviewDevice[] = Object.freeze([
  { name: "Phone", width: 390 },
  { name: "Tablet portrait", width: 768 },
  { name: "Tablet landscape", width: 1024 },
  { name: "Desktop", width: 1440 },
]);
/**
 * The runtime's current frame rendered at several widths side by side, following the
 * runtime's time and state. Widths are player widths (the renderer chooses its layout from
 * its own width), so this previews layouts, not device chrome.
 */
export function DevicePreview({
  runtime,
  devices = PREVIEW_DEVICES,
}: {
  runtime: VisualRuntime;
  devices?: readonly PreviewDevice[];
}) {
  const { frame } = useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
    runtime.getSnapshot,
  );
  const frames = useMemo(
    () =>
      devices.map((device) => ({
        device,
        frame: frameAtWidth(runtime, device.width),
      })),
    [runtime, devices, frame],
  );
  return (
    <section className="ccv-preview" aria-label="Device preview">
      <h2>Device preview</h2>
      <div className="ccv-preview-grid">
        {frames.map(({ device, frame }) => (
          <figure
            key={`${device.name}-${device.width}`}
            className="ccv-preview-device"
          >
            <figcaption>
              {device.name} · {device.width} px · {layoutLabel(frame.layout)}
            </figcaption>
            <SceneView
              frame={frame}
              title={`${runtime.scene.title} (${device.name})`}
            />
          </figure>
        ))}
      </div>
    </section>
  );
}
