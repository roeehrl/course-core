import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import "./inspector.css";
import { X } from "lucide-react";
import type { VisualRuntime } from "@course-core/visuals/headless";
import type { AdminClient, Permission } from "../domain/contracts";
import type { LearnerBlock, LearnerEpisode } from "../domain/learnerView";
import { runInspectorErrorMessage } from "../domain/runInspector";
import { useRemote } from "../hooks/useAdmin";
import { Badge, Button, EmptyState, Loading, Notice, Status, when } from "./ui";
import { RunDetails } from "../views/RunsView";
import { sha256Hex } from "../domain/webCrypto";

/** Who may inspect from the read-only learner view, and against which course. */
export interface InspectorAccess {
  client: AdminClient;
  enrollmentId: string;
  permissions: readonly Permission[];
}
export interface InspectedBlock { episode: LearnerEpisode; block: LearnerBlock; part: number; label: string; read: boolean }
/** The name a block of the learner's lesson goes by in the read-only view and the inspector. */
export function blockLabel(block: LearnerBlock) {
  if (block.type === "text") return "Reading";
  if (block.type === "visual") return "Illustration";
  if (block.type === "media") return `Media${block.required ? "" : " · optional"}`;
  return block.type === "assessment" ? "Check" : "Activity";
}
interface InspectorState {
  access: InspectorAccess;
  open(target: InspectedBlock, opener: HTMLElement | null): void;
  /** Live visual runtimes of the view, by block id, for the visual-state panel. */
  runtimes: Map<string, VisualRuntime>;
  experiences: Map<string, unknown>;
}
export const InspectorContext = createContext<InspectorState | null>(null);
export const useInspector = () => useContext(InspectorContext);

/** Registers a visual block's live runtime so the inspector can read its state. */
export function useRegisterRuntime(blockId: string, runtime: VisualRuntime | undefined, experience: unknown) {
  const inspector = useInspector();
  useEffect(() => {
    if (!inspector || !runtime) return;
    inspector.runtimes.set(blockId, runtime);
    inspector.experiences.set(blockId, experience);
    return () => {
      inspector.runtimes.delete(blockId);
      inspector.experiences.delete(blockId);
    };
  }, [inspector, blockId, runtime, experience]);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
// Also works on a non-secure (plain http) origin, where Web Crypto digests are absent.
const sha256 = (value: unknown) => sha256Hex(canonical(value));

/** Scene, timeline, bindings and hashes of one visual block, live from its runtime. */
export function VisualStatePanel({ runtime, experience }: { runtime: VisualRuntime; experience: unknown }) {
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const [definitionDigest, setDefinitionDigest] = useState<string>();
  useEffect(() => {
    let live = true;
    void sha256(experience).then((digest) => live && setDefinitionDigest(digest), () => live && setDefinitionDigest("unavailable"));
    return () => { live = false; };
  }, [experience]);
  const scene = runtime.scene, frame = snapshot.frame, sceneText = JSON.stringify(scene.nodes) + JSON.stringify(scene.timeline.tracks);
  const bindings = Object.entries(scene.state).map(([key, field]) => ({
    key, field, value: frame.state[key], uses: sceneText.split(`"state":${JSON.stringify(key)}`).length - 1, control: scene.controls?.includes(key) ?? false,
  }));
  return (
    <section className="stack" aria-label="Visual state">
      <h4>Scene</h4>
      <dl className="facts vertical">
        <div><dt>Scene</dt><dd><span className="mono">{scene.id}</span> · {scene.title}</dd></div>
        <div><dt>Layout</dt><dd>{frame.layout} · {frame.width}×{frame.height} · {scene.nodes.length} nodes{frame.reducedMotion ? " · reduced motion" : ""}</dd></div>
      </dl>
      <h4>Timeline</h4>
      <dl className="facts vertical">
        <div><dt>Position</dt><dd>{Math.round(frame.timeMs)} of {frame.durationMs} ms · {snapshot.playing ? "playing" : "paused"}</dd></div>
        <div><dt>Current cue</dt><dd>{frame.cue || "—"}</dd></div>
        <div><dt>Tracks · cues</dt><dd>{scene.timeline.tracks.length} tracks · {scene.timeline.cues.length} cues</dd></div>
      </dl>
      <table className="data-table">
        <caption>Bindings: state the scene reads</caption>
        <thead><tr><th scope="col">State</th><th scope="col">Now</th><th scope="col">Initial</th><th scope="col">Bound uses</th></tr></thead>
        <tbody>
          {bindings.map((b) => (
            <tr key={b.key}>
              <th scope="row" className="mono">{b.key}{b.control && " (control)"}</th>
              <td className="mono">{JSON.stringify(b.value)}</td>
              <td className="mono">{JSON.stringify(b.field.initial)}</td>
              <td>{b.uses}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4>Hashes</h4>
      <dl className="facts vertical">
        <div><dt>Scene fingerprint</dt><dd className="mono">{runtime.exportReplay().sceneFingerprint}</dd></div>
        <div><dt>Visual definition SHA-256</dt><dd className="mono">{definitionDigest ?? "computing…"}</dd></div>
      </dl>
    </section>
  );
}

/** The side pane (full screen on small screens) opened from a block of the learner view, or the
 * whole page of the inspector the learner app frames (which owns closing, so passes no onClose). */
export function InspectorPane({ target, onClose, label = "Debug inspector" }: { target: InspectedBlock; onClose?: () => void; label?: string }) {
  const inspector = useInspector()!;
  const heading = useRef<HTMLHeadingElement>(null);
  const [runId, setRunId] = useState<string>();
  useEffect(() => { heading.current?.focus(); }, [target]);
  const canInspectRuns = inspector.access.permissions.includes("run.inspect") && !!inspector.access.client.runInspector;
  const runtime = target.block.type === "visual" ? inspector.runtimes.get(target.block.id) : undefined;
  return (
    <aside className="learner-view-inspector" aria-label={label}>
      <div className="split-line">
        <div>
          <p className="eyebrow">Debug inspector · read only for learner data; reveals and replays are logged</p>
          <h3 ref={heading} tabIndex={-1}>Part {target.part}: {target.label}</h3>
        </div>
        {onClose && <Button kind="quiet" aria-label="Close the debug inspector" onClick={onClose}><X size={18} aria-hidden="true" /></Button>}
      </div>
      <dl className="facts vertical">
        <div><dt>Lesson</dt><dd>{target.episode.title} <span className="mono">({target.episode.id})</span></dd></div>
        <div><dt>Block</dt><dd><span className="mono">{target.block.id}</span> · {target.block.type}{target.read ? " · read" : ""}</dd></div>
      </dl>
      {target.block.type === "visual" && (runtime ? (
        <VisualStatePanel runtime={runtime} experience={inspector.experiences.get(target.block.id)} />
      ) : (
        <Notice tone="gold">This illustration has no live runtime here (the learner sees its text equivalent).</Notice>
      ))}
      {canInspectRuns ? (
        <EpisodeRuns access={inspector.access} episodeId={target.episode.id} runId={runId} onOpen={setRunId} />
      ) : (
        <p className="muted">Supervisor runs need the run.inspect permission.</p>
      )}
    </aside>
  );
}

function EpisodeRuns({ access, episodeId, runId, onOpen }: { access: InspectorAccess; episodeId: string; runId: string | undefined; onOpen: (id: string | undefined) => void }) {
  const port = access.client.runInspector!;
  const runs = useRemote((signal) => port.enrollmentRuns(access.enrollmentId, episodeId, signal), [port, access.enrollmentId, episodeId]);
  if (runs.loading) return <Loading label="Loading this lesson's runs…" />;
  if (runs.error || !runs.data) return <Notice tone="red">{runInspectorErrorMessage(runs.error)}</Notice>;
  const courseId = runs.data.courseId;
  if (runId && courseId)
    return (
      <div className="stack">
        <Button kind="quiet" onClick={() => onOpen(undefined)}>Back to this lesson's runs</Button>
        <RunDetails courseId={courseId} runId={runId} client={access.client} permissions={access.permissions} />
      </div>
    );
  return (
    <section className="stack" aria-label="Supervisor runs for this lesson">
      <h4>Supervisor runs for this lesson</h4>
      {runs.data.runs.length ? (
        <ul className="selector-list">
          {runs.data.runs.map((run) => (
            <li key={run.id}>
              <button type="button" className="selector-item" onClick={() => onOpen(run.id)} disabled={!courseId}>
                <span>
                  <strong>{run.label}</strong>
                  <small>{when(run.startedAt)}{run.blockId ? ` · block ${run.blockId}` : ""}</small>
                  <Status value={run.status} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No runs for this lesson">No supervisor run started from this lesson.</EmptyState>
      )}
      <Badge>Opening a run shows metadata; its payload stays withheld unless revealed with a receipt.</Badge>
    </section>
  );
}
