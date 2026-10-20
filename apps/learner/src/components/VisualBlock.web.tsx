import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { fromVisualExperience, VisualRuntime, type Frame } from "@course-core/visuals/headless";
import { VisualRuntimePlayer } from "@course-core/visuals/react";
import "@course-core/visuals/styles.css";
import type { VisualBlockProps, VisualContextChange, VisualInteractionContext } from "./VisualBlock";
import { Text, View } from "react-native";
import { styles } from "./ui";
import { companionFocus } from "../client/companionFocus";
import { registerVisualRuntime } from "../client/inspectorBridge";

/** Labelled parts of a scene, in authoring order (bounded). */
function labelledParts(nodes: unknown, found: { id: string; label: string }[] = [], depth = 0) {
  if (!Array.isArray(nodes) || depth > 6) return found;
  for (const node of nodes) {
    if (found.length >= 40 || !node || typeof node !== "object") continue;
    const row = node as { id?: unknown; label?: unknown; children?: unknown };
    if (typeof row.id === "string" && typeof row.label === "string" && row.label.trim())
      found.push({ id: row.id, label: row.label.trim().slice(0, 120) });
    labelledParts(row.children, found, depth + 1);
  }
  return found;
}
export type { VisualBlockProps, VisualContextSource, VisualContextChange, VisualInteractionContext } from "./VisualBlock";

export function VisualBlock({ experience, source, onContextChange }: VisualBlockProps) {
  const callback = useRef(onContextChange);
  callback.current = onContextChange;
  const hasCallback = Boolean(onContextChange);
  // Server refreshes recreate JSON objects. Equal scene data must retain runtime identity.
  const data = useMemo(() => {
    try {
      return experience ? JSON.stringify(experience) : undefined;
    } catch {
      return undefined;
    }
  }, [experience]);
  const prepared = useMemo(() => {
    try {
      if (!data) return undefined;
      const visual = JSON.parse(data);
      const scene = fromVisualExperience(visual);
      const runtime = new VisualRuntime(scene);
      return { runtime, scene, rendererId: visual.rendererId as string, fingerprint: runtime.exportReplay().sceneFingerprint };
    } catch {
      return undefined;
    }
  }, [data, source?.episodeId, source?.blockId]);
  const episodeId = source?.episodeId;
  const blockId = source?.blockId;
  const visualId = experience?.id;
  const identity = useMemo(() => {
    const id = /^[a-z][a-z0-9._:-]{0,127}$/;
    return episodeId && blockId && visualId && [episodeId, blockId, visualId].every(value => id.test(value))
      ? { episodeId, blockId, visualId }
      : null;
  }, [episodeId, blockId, visualId]);
  const lastFrame = useRef<string | null>(null);
  const unavailable = useCallback((reason: Extract<VisualContextChange, {kind: "unavailable"}>["reason"]) => {
    lastFrame.current = null;
    callback.current?.({ kind: "unavailable", source: identity, reason });
  }, [identity]);
  // The live runtime, for the debug inspector's visual-state panel (shown only to authorized staff).
  useEffect(() => {
    if (!prepared || !episodeId || !blockId) return;
    return registerVisualRuntime(episodeId, blockId, prepared.runtime, experience);
  }, [prepared, episodeId, blockId, experience]);
  useEffect(() => {
    if (!prepared) unavailable("unsupported");
    else if (!identity) unavailable("missing-source");
    return () => unavailable("unmounted");
  }, [prepared, identity, unavailable, hasCallback]);
  const onFrame = useCallback((frame: Frame) => {
    if (!prepared || !identity || !callback.current) return;
    const context: VisualInteractionContext = {
      schemaVersion: 1, sceneVersion: prepared.scene.version,
      ...identity, rendererId: prepared.rendererId,
      sceneFingerprint: prepared.fingerprint,
      state: Object.freeze({ ...frame.state }), timeMs: frame.timeMs,
      layout: frame.layout, reducedMotion: frame.reducedMotion,
    };
    // Frame and schema come from the validated runtime, never DOM attributes.
    // Mirror the server transport bound without including geometry or prose.
    const serialized = JSON.stringify(context);
    if (new TextEncoder().encode(serialized).byteLength > 16384) {
      unavailable("render-error");
      return;
    }
    if (lastFrame.current === serialized) return;
    lastFrame.current = serialized;
    callback.current({ kind: "frame", context: Object.freeze(context) });
  }, [prepared, identity, unavailable, hasCallback]);
  const onError = useCallback(() => unavailable("render-error"), [unavailable]);
  const description =
    typeof experience?.accessibility?.description === "string" &&
    experience.accessibility.description.trim()
      ? experience.accessibility.description
      : "This illustration is unavailable. Ask your course team for its explanation.";
  const fallback = (
    <View style={{ gap: 12 }}>
      <Text style={styles.heading}>Illustration · text equivalent</Text>
      <Text style={styles.body}>{description}</Text>
      <Text style={styles.small}>
        This renderer is unavailable here. The course explanation remains
        available.
      </Text>
    </View>
  );
  const parts = useMemo(() => (prepared ? labelledParts(prepared.scene.nodes) : []), [prepared]);
  const pointer = identity && parts.length ? (
    <label style={{ display: "grid", gap: 6, maxWidth: "100%", fontSize: 14 }}>
      <span>Point your companion at a part</span>
      <select
        style={{ minHeight: 44, maxWidth: "100%", fontSize: 16, padding: "6px 10px", borderRadius: 10 }}
        defaultValue=""
        onChange={(event) => {
          const part = parts.find((row) => row.id === event.currentTarget.value);
          companionFocus.setSelection(
            part ? { kind: "visual_node", blockId: identity.blockId, nodeId: part.id, label: part.label } : undefined,
          );
        }}
      >
        <option value="">No part selected</option>
        {parts.map((part) => (
          <option key={part.id} value={part.id}>
            {part.label}
          </option>
        ))}
      </select>
    </label>
  ) : null;
  return (
    <View style={{ gap: 12 }}>
      {source && <Text style={styles.small}>Current illustration · {source.episodeTitle || "Current lesson"}{prepared ? ` · ${prepared.scene.title}` : ""}</Text>}
      {prepared ? <VisualRuntimePlayer runtime={prepared.runtime} fallback={fallback} onFrame={onFrame} onError={onError} /> : fallback}
      {pointer}
    </View>
  );
}
