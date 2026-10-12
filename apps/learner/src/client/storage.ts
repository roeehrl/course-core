import AsyncStorage from "@react-native-async-storage/async-storage";
import type { KeyValueStorage } from "../domain/types";

/** Fall back for blocked/private storage, with a visible notice; never lose typing. */
export function createResilientStorage(
  primary: KeyValueStorage,
  onUnavailable: () => void,
): KeyValueStorage {
  const memory = new Map<string, string>();
  let unavailable = false;
  function warn() {
    if (!unavailable) {
      unavailable = true;
      onUnavailable();
    }
  }
  return {
    async getItem(key) {
      if (unavailable) return memory.get(key) ?? null;
      try {
        const value = await primary.getItem(key);
        if (value !== null) memory.set(key, value);
        return value;
      } catch {
        warn();
        return memory.get(key) ?? null;
      }
    },
    async setItem(key, value) {
      memory.set(key, value);
      if (!unavailable) {
        try {
          await primary.setItem(key, value);
        } catch {
          warn();
        }
      }
    },
  };
}
export const deviceStorage: KeyValueStorage = AsyncStorage;
