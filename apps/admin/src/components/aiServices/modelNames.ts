import { useSyncExternalStore } from "react";
import type { ModelList } from "../../domain/aiServices";

/**
 * Model names for people ("Gemini 3.8 Flash"), not ids ("gemini-3.8-flash"): the names the
 * services list (remembered as Models for each job loads them), else a readable form of the id.
 * The id itself belongs under Technical details.
 */
const names = new Map<string, string>();
let version = 0;
const listeners = new Set<() => void>();
export function rememberModelNames(list: Pick<ModelList, "models">) {
  let changed = false;
  for (const m of list.models)
    // A "name" that is just the id again tells nothing: the readable form is better.
    if (
      m.displayName &&
      m.displayName !== m.remoteModel &&
      names.get(m.remoteModel) !== m.displayName
    ) {
      names.set(m.remoteModel, m.displayName);
      changed = true;
    }
  if (!changed) return;
  version += 1;
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const WORDS: Record<string, string> = {
  gpt: "GPT",
  llama: "Llama",
  ai: "AI",
  tts: "TTS",
  vl: "VL",
};
/** A readable model name from its id: "models/gemini-3.8-flash" → "Gemini 3.8 Flash". */
export function readableModelId(id: string) {
  const last = id.split("/").pop() || id;
  const words = last.split(/[-_\s]+/).filter(Boolean);
  if (!words.length) return id;
  return words
    .map(
      (w) =>
        WORDS[w.toLowerCase()] ??
        (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)),
    )
    .join(" ");
}
export function modelName(id: string) {
  return names.get(id) ?? readableModelId(id);
}
/** `modelName`, re-rendering when a model list brings the services' own names. */
export function useModelName() {
  useSyncExternalStore(subscribe, () => version);
  return modelName;
}
