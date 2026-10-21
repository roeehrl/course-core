import { describe, expect, it } from "vitest";
import { platformCapabilities } from "../src/client/platformCapabilities";
import { LEARNER_APP_VERSION } from "../src/client/apiClient";

describe("platform capabilities report (M02)", () => {
  it("describes the window with the activity target rule, its class and its input modes", () => {
    expect(platformCapabilities(390, "compact", { coarse: true, fine: false })).toEqual({
      target: "web_mobile", appVersion: LEARNER_APP_VERSION, sdkVersion: "0.5.0", layoutClass: "compact", inputModes: ["touch", "keyboard"],
      capabilities: ["activity.declarative", "activity.sandboxed_web", "visual.render"], rendererIds: ["course-core-svg-v1"], nativeModules: [],
    });
    expect(platformCapabilities(1440, "expanded", { coarse: false, fine: true })).toMatchObject({ target: "web_desktop", layoutClass: "expanded", inputModes: ["pointer", "keyboard"] });
    // A tablet with a stylus or trackpad reports both; a browser with no pointer media still has a pointer.
    expect(platformCapabilities(820, "medium", { coarse: true, fine: true }).inputModes).toEqual(["touch", "pointer", "keyboard"]);
    expect(platformCapabilities(599, "compact", { coarse: false, fine: false })).toMatchObject({ target: "web_mobile", inputModes: ["pointer", "keyboard"] });
    expect(platformCapabilities(600, "medium", { coarse: false, fine: false }).target).toBe("web_desktop");
  });
  it("never claims a screen reader or native modules, which the web cannot know or have", () => {
    const report = platformCapabilities(390, "compact", { coarse: true, fine: true });
    expect(report.inputModes).not.toContain("screen_reader");
    expect(report.nativeModules).toEqual([]);
  });
});
