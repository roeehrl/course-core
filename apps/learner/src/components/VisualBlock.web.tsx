import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fromVisualExperience, type Frame, type VisualRuntime } from "@course-core/visuals/headless";
import { LazyVisualPlayer, type VisualCompletion } from "@course-core/visuals/react";
import "@course-core/visuals/styles.css";
import type { VisualBlockProps, VisualContextChange, VisualInteractionContext } from "./VisualBlock";
import { Text, View } from "react-native";
import { styles } from "./ui";
import { companionFocus } from "../client/companionFocus";
import { registerVisualRuntime } from "../client/inspectorBridge";
import { useT } from "../i18n";
import { useVisualMessages } from "./visualMessages";

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
export type { VisualBlockProps, VisualContextSource, VisualContextChange, VisualInteractionContext, VisualCompletionReport } from "./VisualBlock";

export function VisualBlock({ experience, source, onContextChange, onComplete, companionAvailable = true }: VisualBlockProps) {
  const t = useT();
  const { messages, locale } = useVisualMessages();
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
      // Validated now; the runtime is created only when the player nears the viewport.
      const scene = fromVisualExperience(visual);
      return { scene, rendererId: visual.rendererId as string };
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
  // The live runtime (null until loaded, and again once disposed off-screen).
  const [runtime, setRuntime] = useState<VisualRuntime | null>(null);
  const fingerprint = useMemo(() => runtime?.exportReplay().sceneFingerprint, [runtime]);
  // The live runtime, for the debug inspector's visual-state panel (shown only to authorized staff).
  useEffect(() => {
    if (!runtime || !episodeId || !blockId) return;
    return registerVisualRuntime(episodeId, blockId, runtime, experience);
  }, [runtime, episodeId, blockId, experience]);
  useEffect(() => {
    if (!prepared) unavailable("unsupported");
    else if (!identity) unavailable("missing-source");
    return () => unavailable("unmounted");
  }, [prepared, identity, unavailable, hasCallback]);
  const onFrame = useCallback((frame: Frame) => {
    if (!prepared || !identity || !fingerprint || !callback.current) return;
    const context: VisualInteractionContext = {
      schemaVersion: 1, sceneVersion: prepared.scene.version,
      ...identity, rendererId: prepared.rendererId,
      sceneFingerprint: fingerprint,
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
  }, [prepared, identity, fingerprint, unavailable, hasCallback]);
  // Completion is an observation the host records once; it never counts as learning.
  const completed = useRef(onComplete);
  completed.current = onComplete;
  const complete = useCallback((completion: VisualCompletion) => {
    if (identity) completed.current?.({ ...identity, sceneFingerprint: completion.sceneFingerprint });
  }, [identity]);
  const onError = useCallback(() => unavailable("render-error"), [unavailable]);
  const description =
    typeof experience?.accessibility?.description === "string" &&
    experience.accessibility.description.trim()
      ? experience.accessibility.description
      : t("visualBlock.unavailable");
  const fallback = (
    <View style={{ gap: 12 }}>
      <Text style={styles.heading}>{t("visualBlock.textEquivalent")}</Text>
      <Text style={styles.body}>{description}</Text>
      <Text style={styles.small}>{t("visualBlock.web.rendererUnavailable")}</Text>
    </View>
  );
  const parts = useMemo(() => (prepared ? labelledParts(prepared.scene.nodes) : []), [prepared]);
  const pointer = companionAvailable && identity && parts.length ? (
    <label style={{ display: "grid", gap: 6, maxWidth: "100%", fontSize: 14 }}>
      <span>{t("visualBlock.pointer")}</span>
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
        <option value="">{t("visualBlock.noPart")}</option>
        {parts.map((part) => (
          <option key={part.id} value={part.id} dir="auto">
            {part.label}
          </option>
        ))}
      </select>
    </label>
  ) : null;
  return (
    <View style={{ gap: 12 }}>
      {source && (
        <Text style={styles.small}>
          {prepared
            ? t("visualBlock.currentScene", {
                lesson: source.episodeTitle || t("visualBlock.currentLesson"),
                scene: prepared.scene.title,
              })
            : t("visualBlock.current", { lesson: source.episodeTitle || t("visualBlock.currentLesson") })}
        </Text>
      )}
      {prepared ? (
        <LazyVisualPlayer
          scene={prepared.scene}
          placeholder={<p dir="auto">{prepared.scene.accessibility.text}</p>}
          onRuntime={setRuntime}
          fallback={fallback}
          onFrame={onFrame}
          onError={onError}
          onComplete={complete}
          messages={messages}
          locale={locale}
        />
      ) : fallback}
      {pointer}
    </View>
  );
}
