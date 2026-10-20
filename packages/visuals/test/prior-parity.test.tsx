import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { demoScenes } from "../src/demos.js";
import { SceneView } from "../src/react.js";
import { VisualRuntime } from "../src/runtime.js";

/**
 * Hashes of every frame and SVG markup the 0.1.1 build produced for the demo scenes,
 * captured from that build before the 0.2.0 primitives were added. Scenes that use only
 * 0.1.x node kinds must evaluate and render identically (numbers compared to 10 significant
 * digits; output markup rounds coordinates far coarser), which is what lets the API
 * keep serving courses that declared 0.1.0/0.1.1 (REVIEWED_PRIOR_SVG_BUILDS).
 */
const golden = JSON.parse(
  readFileSync(
    new URL("./fixtures/prior-parity.json", import.meta.url),
    "utf8",
  ),
) as Record<string, { frame: string; markup: string }>;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
/** Numbers to 10 significant digits: transcendental results differ in the last bits across
 * platforms (macOS arm64 vs Linux x64), which is not a behaviour change. */
const stable = (text: string) =>
  text.replace(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/g, (n) =>
    Math.abs(Number(n)) < 1e-9 ? "0" : String(Number(Number(n).toPrecision(10))),
  );

test("0.1.x scenes evaluate and render exactly as the 0.1.1 build did", () => {
  const seen: string[] = [];
  for (const scene of demoScenes)
    for (const viewportWidth of [320, 960])
      for (const reducedMotion of [false, true]) {
        const runtime = new VisualRuntime(scene, {
          viewportWidth,
          reducedMotion,
        });
        for (const t of [
          0,
          scene.timeline.durationMs / 2,
          scene.timeline.durationMs,
        ]) {
          runtime.seek(t);
          const frame = runtime.getSnapshot().frame;
          const key = `${scene.id}@${viewportWidth}/${reducedMotion ? "reduced" : "motion"}/${t}`;
          seen.push(key);
          assert.deepEqual(
            {
              frame: sha(stable(JSON.stringify(frame))),
              markup: sha(
                stable(
                  renderToStaticMarkup(
                    <SceneView frame={frame} title={scene.title} />,
                  ),
                ),
              ),
            },
            golden[key],
            key,
          );
        }
      }
  assert.deepEqual(seen.sort(), Object.keys(golden).sort());
});
