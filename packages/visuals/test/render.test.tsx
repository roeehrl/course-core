import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { VisualPlayer, SceneView } from "../src/react.js";
import { evaluateScene } from "../src/runtime.js";
import { demoScenes, sortingDemo } from "../src/demos.js";

test("SSR renders SVG geometry, explicit controls and text alternatives for every demo", () => {
  for (const scene of demoScenes) {
    const html = renderToStaticMarkup(<VisualPlayer scene={scene} />);
    assert.match(html, /<svg/);
    assert.match(html, /Text equivalent/);
    assert.match(html, /Timeline/);
    assert.match(html, /role="group"/);
    assert.doesNotMatch(html, /<script|<foreignObject|<iframe|href="https?:/);
  }
});
test("malformed author data renders a safe fallback", () => {
  const html = renderToStaticMarkup(
    <VisualPlayer
      scene={{ kind: "script" }}
      fallback={<p>Read the accompanying explanation.</p>}
    />,
  );
  assert.match(html, /role="alert"/);
  assert.match(html, /Read the accompanying explanation/);
  assert.doesNotMatch(html, /<svg/);
});
test("SVG text escapes markup and each instance scopes gradient IDs", () => {
  const scene = JSON.parse(JSON.stringify(sortingDemo));
  scene.nodes.push({
    kind: "text",
    id: "escaped",
    text: "<img src=x onerror=alert(1)>",
    x: 10,
    y: 10,
  });
  const frame = evaluateScene(scene);
  const html = renderToStaticMarkup(
    <>
      <SceneView frame={frame} title="One" />
      <SceneView frame={frame} title="Two" />
    </>,
  );
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img/);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length);
});
