import { useEffect, useId, useMemo, useState } from "react";
import { z } from "zod";
import type { VisualRuntime } from "@course-core/visuals/headless";
import { createFetchAdminClient } from "../client/fetchClient";
import { csrfHeaders } from "../ConnectedHost";
import { permissionSchema, type AdminClient } from "../domain/contracts";
import { learnerViewErrorMessage, type LearnerView } from "../domain/learnerView";
import { useRemote } from "../hooks/useAdmin";
import { blockLabel, InspectorContext, InspectorPane, type InspectedBlock } from "./LearnerInspector";
import { Field, Loading, Notice } from "./ui";

/**
 * What the learner app puts on its own window while it frames this page (same origin only): the
 * live runtime of a visual block it is showing, and a way to close the frame. Absent when this page
 * is opened on its own; the inspector then shows the visual as having no live runtime.
 */
export interface CourseInspectorBridge {
  version: 1;
  visual(episodeId: string, blockId: string): { runtime: VisualRuntime; experience: unknown } | undefined;
  close(): void;
}
declare global {
  interface Window { courseInspectorBridge?: CourseInspectorBridge }
}
function parentBridge(): CourseInspectorBridge | undefined {
  try {
    const bridge = window.parent !== window ? window.parent.courseInspectorBridge : undefined;
    return bridge?.version === 1 ? bridge : undefined;
  } catch {
    return undefined; // A cross-origin parent: never trusted.
  }
}

const accessSchema = z.union([
  z.object({ available: z.literal(true), role: z.string().max(40), permissions: z.array(z.string().max(60)).max(64), path: z.string().max(200), receipt: z.string().max(60) }),
  z.object({ available: z.literal(false), permissions: z.array(z.string()).max(0) }),
]);
type Access = z.infer<typeof accessSchema>;
async function loadAccess(enrollmentId: string, signal: AbortSignal): Promise<Access> {
  const response = await fetch(`/api/enrollments/${encodeURIComponent(enrollmentId)}/debug-inspector`, { credentials: "include", cache: "no-store", signal });
  if (!response.ok) throw new Error(response.status === 401 ? "SIGNED_OUT" : "UNAVAILABLE");
  return accessSchema.parse(await response.json());
}

/**
 * The debug inspector the learner app opens beside the current activity (U01), served at
 * /admin/inspector?enrollment=…&episode=…&block=…. It is the same inspector as the read-only
 * learner view: opening it reads that view, so every open writes the same audited receipt
 * (a recorded staff view the learner can see), and runs, payload reveals and replays go through
 * the same routes and permissions. A learner without the permission is refused by the server.
 */
export function EmbeddedInspector(props: Parameters<typeof InspectorContent>[0]) {
  // One landmark and heading for the framed page, whatever state it is in.
  return (
    <main className="inspector-embed" aria-labelledby="inspector-embed-title">
      <h1 id="inspector-embed-title" className="sr-only">Debug inspector</h1>
      <InspectorContent {...props} />
    </main>
  );
}

function InspectorContent({ client: given, search = window.location.search, bridge: givenBridge }: {
  client?: AdminClient; search?: string;
  /** Tests pass the learner window's bridge directly; in the app it is read from the parent frame. */
  bridge?: CourseInspectorBridge;
}) {
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const enrollmentId = params.get("enrollment") ?? "";
  const client = useMemo(() => given ?? createFetchAdminClient({ baseUrl: "/api/admin", requestHeaders: csrfHeaders }), [given]);
  const access = useRemote((signal) => loadAccess(enrollmentId, signal), [enrollmentId]);
  const bridge = useMemo(() => givenBridge ?? parentBridge(), [givenBridge]);
  useEffect(() => {
    if (!bridge) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") bridge.close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bridge]);
  if (!/^[0-9a-f-]{36}$/i.test(enrollmentId)) return <Notice tone="red">Open the debug inspector from a lesson in the learner app.</Notice>;
  if (access.loading) return <Loading label="Checking inspector access…" />;
  if (access.error || !access.data) return <Notice tone="red">The debug inspector is unavailable. Nothing was opened.</Notice>;
  if (!access.data.available)
    return <Notice tone="gold" title="Not available">The debug inspector needs owner or admin access to this enrollment. Nothing was opened or recorded.</Notice>;
  const permissions = access.data.permissions.flatMap((p) => { const parsed = permissionSchema.safeParse(p); return parsed.success ? [parsed.data] : []; });
  return <InspectorView client={client} enrollmentId={enrollmentId} permissions={permissions} episodeId={params.get("episode")} blockId={params.get("block")} bridge={bridge} />;
}

function InspectorView({ client, enrollmentId, permissions, episodeId, blockId, bridge }: {
  client: AdminClient; enrollmentId: string; permissions: ReturnType<typeof permissionSchema.parse>[]; episodeId: string | null; blockId: string | null; bridge: CourseInspectorBridge | undefined;
}) {
  const port = client.learnerView;
  // One read per open: the server records it (the same receipt as the staff learner view).
  const view = useRemote((signal) => port ? port.open(enrollmentId, signal) : Promise.reject(new Error("UNAVAILABLE")), [port, enrollmentId]);
  if (view.loading) return <Loading label="Opening the inspector (this view is recorded)…" />;
  if (view.error || !view.data) return <Notice tone="red">{learnerViewErrorMessage(view.error)}</Notice>;
  return <Pane view={view.data} client={client} enrollmentId={enrollmentId} permissions={permissions} episodeId={episodeId} blockId={blockId} bridge={bridge} />;
}

function Pane({ view, client, enrollmentId, permissions, episodeId, blockId, bridge }: {
  view: LearnerView; client: AdminClient; enrollmentId: string; permissions: ReturnType<typeof permissionSchema.parse>[]; episodeId: string | null; blockId: string | null;
  bridge: CourseInspectorBridge | undefined;
}) {
  const id = useId();
  const episodes = view.snapshot.course.chapters.flatMap((chapter) => chapter.episodes);
  const episode = episodes.find((row) => row.id === episodeId) ?? episodes.find((row) => row.id === view.snapshot.nextEpisodeId) ?? episodes[0];
  const [selected, setSelected] = useState(() => episode?.blocks.find((b) => b.id === blockId)?.id ?? episode?.blocks[0]?.id);
  const state = useMemo(() => ({ access: { client, enrollmentId, permissions }, runtimes: new Map<string, VisualRuntime>(), experiences: new Map<string, unknown>(), open: () => undefined }),
    [client, enrollmentId, permissions]);
  if (!episode) return <Notice tone="gold">This course has no lessons to inspect.</Notice>;
  const index = Math.max(0, episode.blocks.findIndex((b) => b.id === selected));
  const block = episode.blocks[index];
  if (!block) return <Notice tone="gold">This lesson has no parts to inspect.</Notice>;
  // The learner app's own live runtime for this visual, so the panel shows what the learner sees now.
  const live = block.type === "visual" ? bridge?.visual(episode.id, block.id) : undefined;
  state.runtimes.clear();
  state.experiences.clear();
  if (live) {
    state.runtimes.set(block.id, live.runtime);
    state.experiences.set(block.id, live.experience);
  }
  const lesson = view.snapshot.lessons.find((row) => row.id === episode.id);
  const target: InspectedBlock = { episode, block, part: index + 1, label: blockLabel(block), read: Boolean(lesson?.completedBlockIds.includes(block.id)) };
  return (
    <InspectorContext.Provider value={state}>
      <div className="stack">
        <h2 className="sr-only">{episode.title}</h2>
        <p className="muted">Opened {new Date(view.view.viewedAt).toLocaleString()} as {view.view.viewer.role}. This open is recorded and the learner can see it.</p>
        {episode.blocks.length > 1 && (
          <Field label="Part of this lesson" htmlFor={`${id}-part`}>
            <select id={`${id}-part`} value={block.id} onChange={(e) => setSelected(e.target.value)}>
              {episode.blocks.map((b, i) => <option key={b.id} value={b.id}>Part {i + 1} · {blockLabel(b)}</option>)}
            </select>
          </Field>
        )}
        <InspectorPane key={`${episode.id}:${block.id}:${live ? "live" : "static"}`} target={target} label="Inspected part" />
      </div>
    </InspectorContext.Provider>
  );
}
