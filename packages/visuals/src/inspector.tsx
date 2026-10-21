import { useId, useMemo, useState, useSyncExternalStore } from "react";
import { frameAtWidth, runSceneChecks } from "./checks.js";
import type { CheckFailure } from "./checks.js";
import { ExportControls } from "./export.js";
import { sceneFeatures } from "./features.js";
import { flattenNodes } from "./geometry.js";
import { formatNumber, visualMessages } from "./messages.js";
import { SceneView } from "./react.js";
import type { VisualI18nProps } from "./react.js";
import type { VisualMessages } from "./messages.js";
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
  "morph",
] as const;
const round = (n: number) => Number(n.toFixed(3));

/**
 * A design-time parameter inspector for a runtime: every state field (not only the
 * scene's controls), the timeline with jumps to each keyframe, the computed properties of
 * a selected node, and the scene's publish-time checks. It drives the same runtime as the
 * player beside it. A tool for authors; it grants nothing and records nothing.
 */
export function VisualInspector({
  runtime,
  messages,
  locale,
}: { runtime: VisualRuntime } & VisualI18nProps) {
  const m = visualMessages(messages);
  const seconds = (ms: number) =>
    m.seconds(formatNumber(locale, ms / 1000, { min: 2, max: 2 }));
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
            ...[
              ...(scene.timeline.colorTracks ?? []),
              ...(scene.timeline.cameraTracks ?? []),
            ].flatMap((t) => t.keyframes.map((k) => k.atMs)),
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
      setError(cause instanceof Error ? cause.message : m.changeRefused);
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
      <h2 id={`${uid}-title`}>{m.inspectorTitle(scene.title)}</h2>
      <dl className="ccv-inspector-summary">
        <dt>{m.scene}</dt>
        <dd>{scene.id}</dd>
        <dt>{m.layoutHeading}</dt>
        <dd>
          {m.layout[frame.layout]} · {frame.width} × {frame.height}
        </dd>
        <dt>{m.time}</dt>
        <dd>{seconds(frame.timeMs)}</dd>
        <dt>{m.features}</dt>
        <dd>{sceneFeatures(scene).join(", ") || m.none}</dd>
      </dl>
      {error && (
        <p className="ccv-inspector-error" role="alert">
          {error}
        </p>
      )}
      {Object.keys(scene.state).length > 0 && (
        <fieldset className="ccv-inspector-group">
          <legend>{m.parameters}</legend>
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
        <legend>{m.timeline}</legend>
        <label htmlFor={`${uid}-time`}>{m.inspectorTime}</label>
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
          <ul className="ccv-inspector-keyframes" aria-label={m.keyframes}>
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
                  {seconds(t)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      <section className="ccv-inspector-group" aria-labelledby={`${uid}-node`}>
        <h3 id={`${uid}-node`}>{m.node}</h3>
        <label htmlFor={`${uid}-node-select`}>{m.selectedNode}</label>
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
            <caption>{m.computedProperties(node.id)}</caption>
            <tbody>
              <tr>
                <th scope="row">visible</th>
                <td>{String(node.visible)}</td>
              </tr>
              {PROPERTIES.filter((p) => node[p] !== undefined).map((p) => (
                <tr key={p}>
                  <th scope="row">{p}</th>
                  <td>{round(node[p]!)}</td>
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
        <h3 id={`${uid}-checks`}>{m.publishChecks}</h3>
        <p>{m.checkCounts(counts.invariants, counts.goldens)}</p>
        <button
          type="button"
          onClick={() => act(() => setChecks(runSceneChecks(scene)))}
        >
          {m.runChecks}
        </button>
        <div role="status">
          {checks &&
            (checks.length === 0 ? (
              <p className="ccv-inspector-pass">{m.allChecksPass}</p>
            ) : (
              <ul className="ccv-inspector-failures">
                {checks.slice(0, 20).map((f, i) => (
                  <li key={i}>
                    {m.checkKind[f.check]} <code>{f.id}</code> ·{" "}
                    {m.layout[f.layout]} · {m.milliseconds(String(f.atMs))}:{" "}
                    {f.message}
                  </li>
                ))}
              </ul>
            ))}
        </div>
      </section>
      <section
        className="ccv-inspector-group"
        aria-labelledby={`${uid}-export`}
      >
        <h3 id={`${uid}-export`}>{m.exportHeading}</h3>
        <ExportControls runtime={runtime} messages={messages} />
      </section>
    </section>
  );
}

export interface PreviewDevice {
  /** A built-in device (its name comes from the messages) or a host-defined one. */
  id: "phone" | "tabletPortrait" | "tabletLandscape" | "desktop" | string;
  /** Overrides the translated name; required for host-defined devices. */
  name?: string;
  width: number;
  /** The frame drawn around the screen (0.5). */
  chrome: "phone" | "tablet" | "desktop";
}
/** One device per layout mode of the four-layout set. */
export const PREVIEW_DEVICES: readonly PreviewDevice[] = Object.freeze([
  { id: "phone", width: 390, chrome: "phone" },
  { id: "tabletPortrait", width: 768, chrome: "tablet" },
  { id: "tabletLandscape", width: 1024, chrome: "tablet" },
  { id: "desktop", width: 1440, chrome: "desktop" },
]);
/**
 * The runtime's current frame rendered at several widths side by side, following the
 * runtime's time and state, each inside a device frame (0.5): a phone with its status
 * bar, a tablet bezel or a browser window. Widths are player widths (the renderer chooses
 * its layout from its own width); the chrome is drawn by CSS and hidden from assistive
 * technology. Pass `chrome={false}` for the bare frames.
 */
export function DevicePreview({
  runtime,
  devices = PREVIEW_DEVICES,
  chrome = true,
  messages,
}: {
  runtime: VisualRuntime;
  devices?: readonly PreviewDevice[];
  chrome?: boolean;
} & Pick<VisualI18nProps, "messages">) {
  const m = visualMessages(messages);
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
  const nameOf = (device: PreviewDevice) =>
    device.name ??
    (Object.hasOwn(m.devices, device.id)
      ? m.devices[device.id as keyof VisualMessages["devices"]]
      : device.id);
  return (
    <section className="ccv-preview" aria-label={m.devicePreview}>
      <h2>{m.devicePreview}</h2>
      <div className="ccv-preview-grid">
        {frames.map(({ device, frame }) => (
          <figure
            key={`${device.id}-${device.width}`}
            className="ccv-preview-device"
            data-device={device.id}
          >
            <figcaption>
              {m.previewCaption(
                nameOf(device),
                String(device.width),
                m.layout[frame.layout],
              )}
            </figcaption>
            <div
              className={
                chrome
                  ? `ccv-device ccv-device-${device.chrome}`
                  : "ccv-device-bare"
              }
            >
              {chrome && (
                <div className="ccv-device-bar" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
              )}
              <div className="ccv-device-screen">
                <SceneView
                  frame={frame}
                  title={m.previewTitle(runtime.scene.title, nameOf(device))}
                />
              </div>
            </div>
          </figure>
        ))}
      </div>
    </section>
  );
}
