import React, { useEffect, useRef } from "react";
import type { VisualExperience } from "@course-core/sdk";
import { Text, View } from "react-native";
import { styles } from "./ui";
export interface VisualBlockProps {
  experience?: VisualExperience;
  /** The currently displayed lesson/block, supplied by the connected host. */
  source?: VisualContextSource;
  /** Local notification, potentially once per animation frame. Store the latest
   * value; do not send a network request per notification. Unavailable events
   * identify their source so an old block cannot clear a newer block's context.
   * Parent integration attaches only `frame.context` to an explicit request. */
  onContextChange?: (change: VisualContextChange) => void;
}

export interface VisualContextSource {
  episodeId: string;
  blockId: string;
  episodeTitle?: string;
}

/** Wire contract for interactive-context.ts. A bounded current-state snapshot,
 * not a replay, executable scene, author declaration, or evidence receipt.
 * sceneFingerprint is the public runtime's replay fingerprint: a deterministic
 * stale-scene marker, not a cryptographic signature or authorization token. */
export interface VisualInteractionContext {
  schemaVersion: 1;
  sceneVersion: 1;
  episodeId: string;
  blockId: string;
  visualId: string;
  rendererId: string;
  sceneFingerprint: string;
  state: Readonly<Record<string, number | boolean | string>>;
  timeMs: number;
  layout: "compact" | "expanded";
  reducedMotion: boolean;
}

export type VisualContextChange =
  | { kind: "frame"; context: Readonly<VisualInteractionContext> }
  | {
      kind: "unavailable";
      source: { episodeId: string; blockId: string; visualId: string } | null;
      reason: "missing-source" | "unsupported" | "render-error" | "unmounted";
    };

export function VisualBlock({ experience, source, onContextChange }: VisualBlockProps) {
  const callback = useRef(onContextChange);
  callback.current = onContextChange;
  const episodeId = source?.episodeId;
  const blockId = source?.blockId;
  const visualId = experience?.id;
  useEffect(() => {
    const identity = episodeId && blockId && visualId
      ? { episodeId, blockId, visualId }
      : null;
    callback.current?.({ kind: "unavailable", source: identity, reason: "unsupported" });
    return () => callback.current?.({ kind: "unavailable", source: identity, reason: "unmounted" });
  }, [episodeId, blockId, visualId, Boolean(onContextChange)]);
  return (
    <View style={{ gap: 12 }}>
      {source && <Text style={styles.small}>Current illustration · {source.episodeTitle || "Current lesson"}</Text>}
      <Text style={styles.heading}>Illustration · text equivalent</Text>
      <Text style={styles.body}>
        {experience?.accessibility.description ||
          "This illustration is unavailable. Ask your course team for its explanation."}
      </Text>
      <Text style={styles.small}>
        The interactive renderer is available in the web learner. Native
        rendering is not yet connected.
      </Text>
    </View>
  );
}
