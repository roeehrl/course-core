# @course-core/visuals

A standalone, course-agnostic visual runtime: bounded JSON scene/state/expression data → portable geometry and timeline → accessible React/SVG. Three original demos explore neighbor sorting, motion along a curve, and explicit state transitions. The package uses free/open-source dependencies; demos contain no private course content. Code and demos are Apache-2.0 licensed.

## Run and verify

Use Node 26. From this package directory:

```sh
npm ci
npm run check
PLAYWRIGHT_BROWSERS_PATH=./node_modules/.cache/ms-playwright npx playwright install chromium
npm run test:browser
npm run demo
```

The gallery runs at `http://127.0.0.1:4178`. Browser installation/cache and test artifacts stay inside this package. Browser tests exercise Chromium desktop (1440px), tablet (768px), and phone (375px) viewports, including SVG text clipping, controls, real pointer drag, keyboard activation, timeline playback/scrubbing, live media-query changes, and resize state preservation. These are web viewport tests, **not physical-device, Safari, React Native, iOS, or Android qualification**.

`npm run check` runs strict TypeScript checks, Node tests, React server-render tests, and the package build. Tests cover actual transforms, exact quadratic/cubic extrema, plot mapping, links, keyframe easing, seeded simulation/replay, transaction failure, safety bounds and hostile input. Generated `dist/` is not tracked. Run `npm run build` before packaging or consuming the local package. There are no root orchestration or application changes.

## Versioning and released digests

Courses declare this renderer by exact version and dist fingerprint. **Any byte change to `dist` requires a version bump**, including a change confined to the React wrapper. `released-digests.json` records, per released version, the API's svgRenderer fingerprint of `dist` and a digest of the headless entry (`headless.js` and every module it imports). `test/released-digests.test.ts` fails when the built package differs from the record for its version. After a bump, build and record the new entry:

```sh
npm run build && npm run digest
```

Never edit an existing entry. The API accepts a pinned prior build only through its reviewed list, and only while the headless digest is unchanged.

## Embed in a learner application

```tsx
import { VisualPlayer } from "@course-core/visuals/react";
import { motionDemo, demoReferenceChecks } from "@course-core/visuals/demos";
import "@course-core/visuals/styles.css";

export function Example() {
  return (
    <VisualPlayer
      scene={motionDemo}
      options={{ referenceChecks: demoReferenceChecks }}
      onFrame={(frame) => {
        /* trusted host can persist/export state separately */
      }}
      onError={(error) => {
        /* trusted host reporting; do not expose author payloads */
      }}
      fallback={<p>Read the accompanying activity explanation.</p>}
    />
  );
}
```

`VisualPlayer` validates unknown input and owns its runtime. Scene identity, seed, or reference-check registry changes create a fresh runtime; keep those objects stable to preserve state. CSS is an explicit import. The view measures **its container**, not the window. `reducedMotion` optionally overrides the OS preference; default behavior follows it live. Nothing autoplays.

For external state ownership, create one `VisualRuntime` and pass it to `VisualRuntimePlayer`. Its `getSnapshot` and `subscribe` methods support `useSyncExternalStore`; `setState`, `seek`, `play`, `pause`, `advance`, `reset`, `exportReplay`, `restoreReplay`, `setViewport`, and `setReducedMotion` are typed. Use `SceneView` for a controlled pure SVG view with a runtime-produced `Frame`. `Frame`/`SceneView` and host callbacks are trusted integration surfaces; feed untrusted input through `parseScene`/`VisualRuntime`, never cast it to a `Frame`.

## Released SDK contract

The dependency is the released `@course-core/sdk` **v0.2.0** tarball from the SDK's GitHub release. No sibling SDK source or private application source is imported. `toVisualExperience(scene)` returns the released SDK's `VisualExperience` with renderer ID `course-core-svg-v1`; `fromVisualExperience(experience)` validates the embedded scene and rejects divergent outer metadata. The embedded scene is the source of truth. Exported experiences advertise **web only**.

```ts
import {
  fromVisualExperience,
  toVisualExperience,
} from "@course-core/visuals/headless";
const experience = toVisualExperience(sceneData);
const validatedScene = fromVisualExperience(experience);
```

Unknown renderer IDs should fall back to the SDK's accessibility description in the host. This package throws a typed `VisualError` so the host can implement that policy explicitly. Client scene checks, selections, and callbacks **do not grant course credit**. Assessment authority, evidence storage, authorization and progression remain outside this package.

## Supported version-1 scene schema

`Scene` and related exported TypeScript types describe the format. `parseScene(unknown)` accepts an object or JSON string, strictly validates all fields/references, returns a cloned deeply frozen scene, and rejects unknown fields. It does not execute author strings. State is intentionally **one flat map of primitive fields**, with no nested state objects or member access.

| Area             | Supported data                                                                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scene            | `version: 1`, safe `id`, `title`, `description`, `nodes`, `state`, `layouts`, `timeline`, `accessibility`; optional `controls`, `simulation`, `referenceChecks`                                      |
| State            | Number (`initial`, `min`, `max`, `step`), boolean (`initial`), enum (`initial`, unique `options`); each has a `label`                                                                                |
| Nodes            | `group`, `rect`, `circle`, `ellipse`, `line`, `text`, structured `path`, `plot`, geometric `link`                                                                                                    |
| Common node data | Unique `id`; expressions for `x`, `y`, `rotation` in degrees, positive uniform `scale`, `opacity`, boolean `visible`; optional `label`, `fill`, `stroke`, `strokeWidth`, `manipulate`                |
| Paint            | `#rgb`, `#rrggbb`, `#rrggbbaa`, `none`, or a fixed two-stop diagonal `{kind:'linear', from, to}` fill; solid stroke only                                                                             |
| Rectangle        | `width`, `height`, optional `cornerRadius`; position is top-left                                                                                                                                     |
| Circle / ellipse | `radius` or `width`/`height`; position is center                                                                                                                                                     |
| Text             | Primitive/expression `text`, `fontSize`, `weight: normal/bold`, `align: start/middle/end`; position is baseline                                                                                      |
| Path             | Commands `M`, `L`, `Q`, `C`, `Z`, each with typed numeric/expression coordinates. First command must be `M`. No raw SVG path strings                                                                 |
| Plot             | Bounded point array, increasing `domainX`/`domainY`, `width`/`height`, optional `area`. Values outside the domains fail closed. Positive y is plotted upward                                         |
| Link             | `from`/`to` node IDs and `center/top/right/bottom/left/auto` anchors, optional cubic `bend`, arrow and draw `progress`. Links are geometric connections, **not URL navigation**                      |
| Layout           | Required compact and expanded `width`/`height` plus numeric-property overrides keyed by node ID. Optional `breakpoint` (default 640 container CSS pixels). Same semantic nodes/state in both layouts |
| Timeline         | Bounded `durationMs`, numeric-property tracks, strictly increasing keyframes, ordered textual cues                                                                                                   |
| Accessibility    | Required meaningful `text`; representative reduced-motion `atMs` and `description`                                                                                                                   |

Numeric track/override properties: `x`, `y`, `rotation`, `scale`, `opacity`, `width`, `height`, `radius`, `fontSize`, `x2`, `y2`, `progress`. A property must belong to the target node kind. Tracks take precedence over layout overrides, which take precedence over node values. Layout-specific animated distances can be expressed through parent transforms. Links use world geometry and cannot carry transforms or manipulation. Group bounds union child geometry, excluding links; stroke/markers do not expand bounds. `auto` link anchors choose the facing edges of target bounds for horizontal/vertical reflow.

### Expression AST

Expressions are literals (`number`, `boolean`, `string`), `{state:'fieldId'}`, `{time:true}` (milliseconds), `{sample:'label'}`, or `{op:'add', args:[…]}`. Strings are **always literal text**, never formulas, templates, source code or HTML.

Supported operators: `add sub mul div mod pow min max clamp lerp abs sqrt sin cos floor round eq lt lte gt gte and or not concat if`. Numeric operators require numbers; boolean operators require booleans; `eq` is strict primitive equality; `concat` explicitly converts primitives to text. `if`, `and`, and `or` short circuit. Trigonometric inputs are radians. `clamp(value,min,max)` rejects reversed limits. `lerp(a,b,t)` is arithmetic interpolation (t is not automatically clamped). Division/modulo by zero, nonfinite results, overflow and out-of-budget evaluation throw. Numeric results are bounded to ±1e9; exponents to ±32; output text to 2048 characters.

```ts
const dynamicX = {
  op: "add",
  args: [20, { op: "mul", args: [{ state: "position" }, 5] }],
};
const label = { op: "concat", args: ["Position: ", { state: "position" }] };
```

### Timing, manipulation and replay

Keyframes interpolate with `linear`, `smooth` (smoothstep), `in` (quadratic), `out` (quadratic), or `step`. The destination keyframe selects segment easing. Values hold before the first/after the last keyframe; timeline time clamps to `[0,durationMs]`. `play()` restarts at zero after completion. The headless runtime takes explicit elapsed milliseconds and has no wall clock or scheduler. The React adapter uses requestAnimationFrame, caps a browser frame delta at 100ms, and pauses when the tab becomes hidden.

`manipulate.x/y` bind numeric state to a parent-coordinate interval `{state,from,to}`. Pointer coordinates invert parent transforms, map into field limits, snap to step, and clamp. Arrow keys change by one step; Shift by ten; Home/End go to bounds. Up/Right increase; Down/Left decrease. `manipulate.activate: {state,value}` sets a validated value on click, Enter or Space. Every interactive node requires a label. Native HTML range, checkbox and select controls remain an alternative to spatial gestures.

Optional simulation declares a uint32 `seed`, fixed `stepMs`, and state `updates` containing the same safe AST. Tick updates are simultaneous against the previous state. Events before a tick apply first; events exactly at a tick apply after its updates. `{sample:'label'}` is a deterministic uint32-derived sample in `[0,1)` keyed by seed/tick/label, independent of evaluation ordering. Simulation results must satisfy the state field limits. No physics engine, hidden randomness, external networking, or author callbacks run.

Seeks recompute from initial state + recorded events + fixed ticks. A replay contains version, scene ID, a canonical scene fingerprint, seed, and ordered timestamped state changes. Export/restore round-trip the sequence. Editing after seeking backwards discards future events and branches history; writes at the same timestamp coalesce. Replay import validates shape, fields and bounds, and is transactional. Failed seek/state/restore evaluation retains the last valid frame. The fingerprint detects accidental scene mismatch; **it is not a cryptographic signature**. Cross-JavaScript-engine transcendental results are not promised bit-identical; platform reference checks should use appropriate tolerances.

`referenceChecks` are names only. The trusted host registers `ReferenceCheck` functions in runtime options and explicitly calls `runReferenceChecks()`. Missing, throwing or non-passing checks report failure. Scene JSON cannot provide those functions. Check results are diagnostic, not grading/progression evidence.

### Bounds and trust boundary

Maximums: conservative 1MB payload estimate, 70,000 JSON entries, JSON depth 64, 400 scene nodes, 12 group levels, 16 expression levels, 64 flat state fields, 120 seconds, 800 tracks, 256 keyframes per track, 256 cues, 10,000 combined path/plot points, 512 replay events, and 500,000 expression visits per evaluated frame/seek. Simulation tick interval is 16–1000ms. Individual paths cap at 1024 commands and plots at 2048 points. These are upper bounds, not a promise every maximal combination fits the evaluation budget. Split complex studies into separate scenes. ViewBox dimensions are 100–4096; scale .001–100; sizes 0–100,000; opacity/progress 0–1.

The parser rejects cycles, prototype keys, accessors, non-JSON objects, unknown node kinds/operators/fields, unresolved references, duplicate IDs/tracks, malformed timelines, nonfinite numbers, unsafe paints and raw executable data. Dynamic values are checked again when evaluated. Invalid runtime changes fail closed with a readable UI message and last-valid-frame preservation. There is no `eval`, `new Function`, author JavaScript, arbitrary HTML/SVG markup, resource URL, image loading or external navigation field. Screenshots are verification artifacts only; they are never executable input. Pass JSON data rather than live objects with proxies; code already able to create a Proxy in the host is outside the scene-data trust boundary.

## Accessibility and fallback

Every scene needs a useful textual equivalent. The player exposes a description, all authored cues, current primitive state, readable labels, focus outlines and keyboard-operable controls. Reduced motion starts at the authored representative frame, disables automatic playback, expands the text equivalent and retains discrete seeking/manipulation. Changing the media preference stops playback. Live announcements are quiet during playback. The renderer escapes text using React and generates scoped internal gradient/marker IDs. It uses SVG/HTML, never an arbitrary app-canvas script.

Unsupported/invalid scenes show the provided trusted React fallback, or a plain error message. If a dynamic expression fails, playback pauses and the previous frame remains visible; Reset offers recovery. A complete learning explanation still belongs in the course's authored fallback text; this library cannot infer missing semantics from geometry. Automated checks are not a screen-reader audit.

## Headless and future native adapter

```ts
import { VisualRuntime, flattenNodes } from "@course-core/visuals/headless";
const runtime = new VisualRuntime(sceneData, {
  viewportWidth: 375,
  reducedMotion: true,
});
const frame = runtime.seek(500);
// Feed positions, affine matrices, shapes, paths and text into a platform renderer.
const geometry = flattenNodes(frame.nodes);
```

The headless entrypoint has no React, DOM, browser timers, canvas, Node built-ins or network imports. It returns deeply frozen data: absolute affine transforms, shape/path geometry, world bounds, plot points, labels, state, timing and text. A native host must supply drawing, font measurement, gestures, keyboard/accessibility semantics, viewport size, reduced-motion settings, scheduling, replay persistence, and rendering-error UX. The current renderer is **React DOM + SVG only**. **No RN/native renderer, build, physical device test, native accessibility claim or native qualification is included; native work is deferred.** React/React DOM are peers for web consumers; native bundlers should use `./headless` and omit the web entrypoint.

Known limits: no automatic text wrapping or shaping; text bounds use a deterministic approximate advance and must be measured by a future native adapter. Paths support M/L/Q/C/Z, not arcs; no filters/masks, raster media, arbitrary CSS, external assets, URL links, collision solver, drag inertia, or general scripting. Group opacity is multiplied per descendant, not offscreen compositing. Interpolation is numeric, not path morphing or color animation. Group bounds ignore connectors, and stroke/arrow extents are not included. `progress` reveals strokes only. Compact/expanded are authored layouts, not a general constraint solver. Node identity, state, and replay survive viewport changes.
