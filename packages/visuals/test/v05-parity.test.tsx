import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  demoScenes,
  lensDemo,
  motionStudyDemo,
  primitivesDemo,
} from "../src/demos.js";
import { SceneView } from "../src/react.js";
import { VisualRuntime } from "../src/runtime.js";
import { renderSvg } from "../src/svg.js";

/**
 * Hashes of every frame, React markup and headless SVG the 0.5.1 build produced for the demo
 * scenes (including the 0.3 motion study and the 0.5 primitives), at four widths, with and
 * without reduced motion, at five points in time. 0.5.2 moved every diagnostic into the error
 * catalog, which changed the headless bytes; it must still evaluate and render 0.5 scenes
 * exactly as 0.5.1 (and so 0.5.0, the same headless bytes) did. That is what lets the API serve
 * courses that declared 0.5.0 or 0.5.1 with all their features (REVIEWED_PRIOR_SVG_BUILDS).
 */
const golden = JSON.parse(
  readFileSync(
    new URL("./fixtures/parity-0.5.1.json", import.meta.url),
    "utf8",
  ),
) as Record<string, { frame: string; markup: string; svg: string }>;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
/** Numbers to 10 significant digits, as in prior-parity.test.tsx. */
const stable = (text: string) =>
  text.replace(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/g, (n) =>
    Math.abs(Number(n)) < 1e-9
      ? "0"
      : String(Number(Number(n).toPrecision(10))),
  );

test("0.5 scenes evaluate and render exactly as the 0.5.1 build did", () => {
  const seen: string[] = [];
  for (const scene of [
    ...demoScenes,
    primitivesDemo,
    motionStudyDemo,
    lensDemo,
  ])
    for (const viewportWidth of [320, 800, 1100, 1600])
      for (const reducedMotion of [false, true]) {
        const runtime = new VisualRuntime(scene, {
          viewportWidth,
          reducedMotion,
        });
        const d = scene.timeline.durationMs;
        for (const t of [0, d / 4, d / 2, (3 * d) / 4, d]) {
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
              svg: sha(
                stable(renderSvg(frame, { idPrefix: "p", title: scene.title })),
              ),
            },
            golden[key],
            key,
          );
        }
      }
  assert.deepEqual(seen.sort(), Object.keys(golden).sort());
});
