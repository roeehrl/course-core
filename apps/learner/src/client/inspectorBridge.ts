import { useSyncExternalStore } from "react";
import type { VisualRuntime } from "@course-core/visuals/headless";

/**
 * The live visual runtimes this learner app is showing, by lesson and block, so the debug
 * inspector framed beside the activity can show the visual state the learner sees now (scene,
 * timeline, bindings and hashes). The registry is local; it is exposed on this window only while
 * the inspector is open (same-origin frame), as `courseInspectorBridge`.
 */
interface Entry { runtime: VisualRuntime; experience: unknown }
const runtimes = new Map<string, Entry>();
const key = (episodeId: string, blockId: string) => `${episodeId}\u0000${blockId}`;

export function registerVisualRuntime(episodeId: string, blockId: string, runtime: VisualRuntime, experience: unknown) {
  const id = key(episodeId, blockId), entry = { runtime, experience };
  runtimes.set(id, entry);
  return () => {
    if (runtimes.get(id) === entry) runtimes.delete(id);
  };
}

export interface CourseInspectorBridge {
  version: 1;
  visual(episodeId: string, blockId: string): Entry | undefined;
  close(): void;
}
declare global {
  interface Window { courseInspectorBridge?: CourseInspectorBridge }
}

/** Whether the inspector is open, for visuals that load lazily: while it is, they load and stay
 * loaded, so it can show the live state of any part of the lesson. */
let inspecting = false;
const watchers = new Set<() => void>();
function setInspecting(value: boolean) {
  inspecting = value;
  for (const watcher of watchers) watcher();
}
export function useInspectorOpen(): boolean {
  return useSyncExternalStore(
    (change) => {
      watchers.add(change);
      return () => watchers.delete(change);
    },
    () => inspecting,
    () => false,
  );
}

/** Exposes the bridge while the inspector is open; returns the function that withdraws it. */
export function openInspectorBridge(close: () => void) {
  const bridge: CourseInspectorBridge = { version: 1, visual: (episodeId, blockId) => runtimes.get(key(episodeId, blockId)), close };
  window.courseInspectorBridge = bridge;
  setInspecting(true);
  return () => {
    if (window.courseInspectorBridge === bridge) {
      delete window.courseInspectorBridge;
      setInspecting(false);
    }
  };
}
