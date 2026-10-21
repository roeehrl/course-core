import type { LayoutClass } from "@course-core/sdk";
import { LEARNER_APP_VERSION } from "./apiClient";

/** The SDK release this app is built against (package.json pins its tarball). */
export const LEARNER_SDK_VERSION = "0.5.0";

export type InputMode = "touch" | "pointer" | "keyboard";

/** What this app reports it can do (the SDK PlatformCapabilities record, M02). */
export interface PlatformCapabilitiesReport {
  target: "web_desktop" | "web_mobile";
  appVersion: string;
  sdkVersion: string;
  layoutClass: LayoutClass;
  inputModes: InputMode[];
  capabilities: string[];
  rendererIds: string[];
  nativeModules: string[];
}

/**
 * The web app's capabilities for a window: its target (the same width rule activities use),
 * window class and input modes. It describes the device only; the server still decides what
 * runs. Screen readers cannot be detected on the web and are never claimed.
 */
export function platformCapabilities(
  width: number,
  layoutClass: LayoutClass,
  media: { coarse: boolean; fine: boolean },
): PlatformCapabilitiesReport {
  const inputModes: InputMode[] = [];
  if (media.coarse) inputModes.push("touch");
  if (media.fine || !media.coarse) inputModes.push("pointer");
  inputModes.push("keyboard");
  return {
    target: width < 600 ? "web_mobile" : "web_desktop",
    appVersion: LEARNER_APP_VERSION,
    sdkVersion: LEARNER_SDK_VERSION,
    layoutClass,
    inputModes,
    capabilities: ["activity.declarative", "activity.sandboxed_web", "visual.render"],
    rendererIds: ["course-core-svg-v1"],
    nativeModules: [],
  };
}

/** The pointer media features of this browser, or none outside one. */
export function pointerMedia(): { coarse: boolean; fine: boolean } {
  const query = (q: string) => {
    try {
      return typeof matchMedia === "function" && matchMedia(q).matches;
    } catch {
      return false;
    }
  };
  // i18n-ignore: CSS media queries, never shown to people
  return { coarse: query("(pointer: coarse)"), fine: query("(pointer: fine)") };
}
