import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import "./inspector.css";
import { X } from "lucide-react";
import type { VisualRuntime } from "@course-core/visuals/headless";
import type { AdminClient, Permission } from "../domain/contracts";
import type { LearnerBlock, LearnerEpisode } from "../domain/learnerView";
import { runInspectorErrorMessage } from "../domain/runInspector";
import { useRemote } from "../hooks/useAdmin";
import { Badge, Button, EmptyState, Loading, Notice, Status } from "./ui";
import {
  englishTranslator,
  useFormatters,
  useI18n,
  useT,
  type Translate,
} from "../i18n";
import { RunDetails } from "../views/RunsView";
import { sha256Hex } from "../domain/webCrypto";

/** Who may inspect from the read-only learner view, and against which course. */
export interface InspectorAccess {
  client: AdminClient;
  enrollmentId: string;
  permissions: readonly Permission[];
}
export interface InspectedBlock {
  episode: LearnerEpisode;
  block: LearnerBlock;
  part: number;
  label: string;
  read: boolean;
}
/** The name a block of the learner's lesson goes by in the read-only view and the inspector. */
export function blockLabel(
  block: LearnerBlock,
  t: Translate = englishTranslator().t,
) {
  if (block.type === "text") return t("learnerInspector.block.text");
  if (block.type === "visual") return t("learnerInspector.block.visual");
  if (block.type === "media")
    return block.required
      ? t("learnerInspector.block.media")
      : t("learnerInspector.block.mediaOptional");
  return block.type === "assessment"
    ? t("learnerInspector.block.assessment")
    : t("learnerInspector.block.activity");
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
export function useRegisterRuntime(
  blockId: string,
  runtime: VisualRuntime | undefined,
  experience: unknown,
) {
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
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
// Also works on a non-secure (plain http) origin, where Web Crypto digests are absent.
const sha256 = (value: unknown) => sha256Hex(canonical(value));

/** Scene, timeline, bindings and hashes of one visual block, live from its runtime. */
export function VisualStatePanel({
  runtime,
  experience,
}: {
  runtime: VisualRuntime;
  experience: unknown;
}) {
  const t = useT();
  const i18n = useI18n();
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const [definitionDigest, setDefinitionDigest] = useState<string>();
  useEffect(() => {
    let live = true;
    void sha256(experience).then(
      (digest) => live && setDefinitionDigest(digest),
      () => live && setDefinitionDigest("unavailable"),
    );
    return () => {
      live = false;
    };
  }, [experience]);
  const scene = runtime.scene,
    frame = snapshot.frame,
    sceneText =
      JSON.stringify(scene.nodes) + JSON.stringify(scene.timeline.tracks);
  const bindings = Object.entries(scene.state).map(([key, field]) => ({
    key,
    field,
    value: frame.state[key],
    uses: sceneText.split(`"state":${JSON.stringify(key)}`).length - 1,
    control: scene.controls?.includes(key) ?? false,
  }));
  return (
    <section className="stack" aria-label={t("learnerInspector.visual.label")}>
      <h4>{t("learnerInspector.visual.scene")}</h4>
      <dl className="facts vertical">
        <div>
          <dt>{t("learnerInspector.visual.scene")}</dt>
          <dd>
            <span className="mono" dir="ltr">
              {scene.id}
            </span>{" "}
            · <bdi>{scene.title}</bdi>
          </dd>
        </div>
        <div>
          <dt>{t("learnerInspector.visual.layout")}</dt>
          <dd>
            {frame.reducedMotion
              ? t("learnerInspector.visual.layoutValueReduced", {
                  layout: frame.layout,
                  width: frame.width,
                  height: frame.height,
                  nodes: scene.nodes.length,
                })
              : t("learnerInspector.visual.layoutValue", {
                  layout: frame.layout,
                  width: frame.width,
                  height: frame.height,
                  nodes: scene.nodes.length,
                })}
          </dd>
        </div>
      </dl>
      <h4>{t("learnerInspector.visual.timeline")}</h4>
      <dl className="facts vertical">
        <div>
          <dt>{t("learnerInspector.visual.position")}</dt>
          <dd>
            {snapshot.playing
              ? t("learnerInspector.visual.positionPlaying", {
                  time: Math.round(frame.timeMs),
                  duration: frame.durationMs,
                })
              : t("learnerInspector.visual.positionPaused", {
                  time: Math.round(frame.timeMs),
                  duration: frame.durationMs,
                })}
          </dd>
        </div>
        <div>
          <dt>{t("learnerInspector.visual.cue")}</dt>
          <dd dir="auto">{frame.cue || "—"}</dd>
        </div>
        <div>
          <dt>{t("learnerInspector.visual.tracksCues")}</dt>
          <dd>
            {t("learnerInspector.visual.tracksCuesValue", {
              tracks: scene.timeline.tracks.length,
              cues: scene.timeline.cues.length,
            })}
          </dd>
        </div>
      </dl>
      <table className="data-table">
        <caption>{t("learnerInspector.bindings.caption")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("learnerInspector.bindings.state")}</th>
            <th scope="col">{t("learnerInspector.bindings.now")}</th>
            <th scope="col">{t("learnerInspector.bindings.initial")}</th>
            <th scope="col">{t("learnerInspector.bindings.uses")}</th>
          </tr>
        </thead>
        <tbody>
          {bindings.map((b) => (
            <tr key={b.key}>
              <th scope="row" className="mono">
                <span dir="ltr">{b.key}</span>
                {b.control && ` ${t("learnerInspector.bindings.control")}`}
              </th>
              <td className="mono" dir="ltr">
                {JSON.stringify(b.value)}
              </td>
              <td className="mono" dir="ltr">
                {JSON.stringify(b.field.initial)}
              </td>
              <td>{i18n.number(b.uses)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4>{t("learnerInspector.hashes.title")}</h4>
      <dl className="facts vertical">
        <div>
          <dt>{t("learnerInspector.hashes.scene")}</dt>
          <dd className="mono" dir="ltr">
            {runtime.exportReplay().sceneFingerprint}
          </dd>
        </div>
        <div>
          <dt>{t("learnerInspector.hashes.definition")}</dt>
          {definitionDigest === undefined ? (
            <dd>{t("learnerInspector.hashes.computing")}</dd>
          ) : definitionDigest === "unavailable" ? (
            <dd>{t("learnerInspector.hashes.unavailable")}</dd>
          ) : (
            <dd className="mono" dir="ltr">
              {definitionDigest}
            </dd>
          )}
        </div>
      </dl>
    </section>
  );
}

/** The side pane (full screen on small screens) opened from a block of the learner view, or the
 * whole page of the inspector the learner app frames (which owns closing, so passes no onClose). */
export function InspectorPane({
  target,
  onClose,
  label,
}: {
  target: InspectedBlock;
  onClose?: () => void;
  label?: string;
}) {
  const t = useT();
  const inspector = useInspector()!;
  const heading = useRef<HTMLHeadingElement>(null);
  const [runId, setRunId] = useState<string>();
  useEffect(() => {
    heading.current?.focus();
  }, [target]);
  const canInspectRuns =
    inspector.access.permissions.includes("run.inspect") &&
    !!inspector.access.client.runInspector;
  const runtime =
    target.block.type === "visual"
      ? inspector.runtimes.get(target.block.id)
      : undefined;
  return (
    <aside
      className="learner-view-inspector"
      aria-label={label ?? t("learnerInspector.label")}
    >
      <div className="split-line">
        <div>
          <p className="eyebrow">{t("learnerInspector.eyebrow")}</p>
          <h3 ref={heading} tabIndex={-1}>
            {t("learnerInspector.partHeading", {
              part: target.part,
              label: target.label,
            })}
          </h3>
        </div>
        {onClose && (
          <Button
            kind="quiet"
            aria-label={t("learnerInspector.close")}
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </Button>
        )}
      </div>
      <dl className="facts vertical">
        <div>
          <dt>{t("learnerInspector.lesson")}</dt>
          <dd>
            <bdi>{target.episode.title}</bdi>{" "}
            <span className="mono" dir="ltr">
              ({target.episode.id})
            </span>
          </dd>
        </div>
        <div>
          <dt>{t("learnerInspector.block")}</dt>
          <dd>
            <span className="mono" dir="ltr">
              {target.block.id}
            </span>{" "}
            · <span dir="ltr">{target.block.type}</span>
            {target.read && ` · ${t("learnerInspector.read")}`}
          </dd>
        </div>
      </dl>
      {target.block.type === "visual" &&
        (runtime ? (
          <VisualStatePanel
            runtime={runtime}
            experience={inspector.experiences.get(target.block.id)}
          />
        ) : (
          <Notice tone="gold">{t("learnerInspector.noRuntime")}</Notice>
        ))}
      {canInspectRuns ? (
        <EpisodeRuns
          access={inspector.access}
          episodeId={target.episode.id}
          runId={runId}
          onOpen={setRunId}
        />
      ) : (
        <p className="muted">
          {t("learnerInspector.runsNeedPermission", {
            permission: "run.inspect",
          })}
        </p>
      )}
    </aside>
  );
}

function EpisodeRuns({
  access,
  episodeId,
  runId,
  onOpen,
}: {
  access: InspectorAccess;
  episodeId: string;
  runId: string | undefined;
  onOpen: (id: string | undefined) => void;
}) {
  const t = useT();
  const { when } = useFormatters();
  const port = access.client.runInspector!;
  const runs = useRemote(
    (signal) => port.enrollmentRuns(access.enrollmentId, episodeId, signal),
    [port, access.enrollmentId, episodeId],
  );
  if (runs.loading)
    return <Loading label={t("learnerInspector.runs.loading")} />;
  if (runs.error || !runs.data)
    return (
      <Notice tone="red">{runInspectorErrorMessage(runs.error, t)}</Notice>
    );
  const courseId = runs.data.courseId;
  if (runId && courseId)
    return (
      <div className="stack">
        <Button kind="quiet" onClick={() => onOpen(undefined)}>
          {t("learnerInspector.runs.back")}
        </Button>
        <RunDetails
          courseId={courseId}
          runId={runId}
          client={access.client}
          permissions={access.permissions}
        />
      </div>
    );
  return (
    <section className="stack" aria-label={t("learnerInspector.runs.title")}>
      <h4>{t("learnerInspector.runs.title")}</h4>
      {runs.data.runs.length ? (
        <ul className="selector-list">
          {runs.data.runs.map((run) => (
            <li key={run.id}>
              <button
                type="button"
                className="selector-item"
                onClick={() => onOpen(run.id)}
                disabled={!courseId}
              >
                <span>
                  <strong dir="auto">{run.label}</strong>
                  <small>
                    {run.blockId
                      ? t("learnerInspector.runs.startedInBlock", {
                          when: when(run.startedAt),
                          block: run.blockId,
                        })
                      : when(run.startedAt)}
                  </small>
                  <Status value={run.status} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title={t("learnerInspector.runs.empty.title")}>
          {t("learnerInspector.runs.empty.body")}
        </EmptyState>
      )}
      <Badge>{t("learnerInspector.runs.payloadWithheld")}</Badge>
    </section>
  );
}
