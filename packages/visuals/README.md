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

Courses declare this renderer by exact version and dist fingerprint (`integrity`). **Any change to the built package requires a version bump**, including a change confined to the React wrapper or the manifest. The only exception is the pin of a reviewed type-only dependency.

`released-digests.json` records per released version:

- **Legacy fingerprint** (`integrity`, `headless`): the original algorithm, which hashes the `.js`/`.css`/`.json` dist files and the whole `dependencies` map. It stays the value courses declare. `legacyBasis` is the dependency map each fingerprint was computed with, so the test re-derives the recorded fingerprints from the current dist bytes. A match proves the bytes are the released ones, whatever the current pins say.
- **Package identity** (`identity`, recorded from 0.1.1): the sha256 of every file under `dist` (`files`), plus the parsed manifest in its own key order (Node resolves export conditions in key order), with the pins of the release's `typeOnlyDependencies` removed. Nothing else is left out:
  - Every manifest entry point must be a hashed file inside `dist`.
  - Symlinks, special files, unexpected file types and duplicate manifest keys refuse the build.
  - `@course-core/sdk` is the only type-only dependency. `src` imports it with `import type` only, and the identity refuses any dist code that names it.
- `headlessFiles`: the files reachable from the `./headless` export. The 0.1.0 and 0.1.1 values are identical, which was the basis for the 0.1.1 API serving pinned 0.1.0 courses. 0.2.0 changed them (new node kinds); it serves 0.1.0 and 0.1.1 declarations on behavioural parity instead (see below).

The digest also lints dist code. It refuses the following:

- dynamic `import()`;
- a manifest whose `type` is not `"module"`, and the CommonJS bindings `require`, `module`, `exports`, `__dirname` and `__filename`;
- `import.meta`, `createRequire`, `process`, `globalThis`/`global`/`self`/`window[…]`, `eval`, `Function`;
- reflective calls, computed member names and constructor access;
- workers and worklets, WebAssembly, script injection, CSS `@import`/`url()`;
- `node:` builtins and undeclared packages;
- line continuations, and specifiers that are not plain one-line strings or that contain quotes, escapes or `..`;
- escaped manifest keys.

Declaration files are hashed, and their specifiers are linted. Nothing may load them: code imports and runtime entry conditions must name `.js`, `.mjs` or `.json` files, and only a `types` condition, as one plain path, may name a declaration. The API refuses to serve the renderer when the `types` resolution condition is enabled (`--conditions`/`-C`).

The lint supports review of fixed, recorded bytes. It is not a proof about arbitrary code. That is why only a recorded release, reviewed as such, gets the type-only relaxation.

`test/released-digests.test.ts` fails when the built package's identity or files differ from the record for its version, or when the recorded fingerprints cannot be re-derived from its bytes. After a bump, build and record the new entry:

```sh
npm run build && npm run digest
```

Never change a recorded value. The API (`services/api/src/svg-renderer.ts`) treats an installed build as a recorded release only while it reproduces that release's identity. In that case it advertises the recorded fingerprint, also accepts the identity as a declaration of the same version, and serves its reviewed prior builds. Any other build advertises its strict identity, with no relaxation, and serves nothing else. A build the lint refuses is not served at all.

0.2.0 serves courses that declared 0.1.0 or 0.1.1 because the scene grammar only grew: `test/prior-parity.test.tsx` checks that every 0.1.x demo scene, at both layouts, with and without reduced motion and at three times, produces the same frame and the same SVG markup as the 0.1.1 build did (hashes captured from that build). Such a declaration gets only the 0.1.x render features (`gradient`, `path_draw`), so publication refuses a 0.1.x course that uses a 0.2 primitive (see Render features).

## Released SDK contract

The dependency is the released `@course-core/sdk` **v0.5.0** tarball from the SDK's GitHub release. No sibling SDK source or private application source is imported. The package imports SDK types only; its built JavaScript is byte-identical under SDK 0.2.0 and 0.5.0, so 0.1.1 kept its version and released fingerprint when the pin moved. `toVisualExperience(scene)` returns the released SDK's `VisualExperience` with renderer ID `course-core-svg-v1`; `fromVisualExperience(experience)` validates the embedded scene and rejects divergent outer metadata. The embedded scene is the source of truth. Exported experiences advertise **web only**.

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

| Area             | Supported data                                                                                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scene            | `version: 1`, safe `id`, `title`, `description`, `nodes`, `state`, `layouts`, `timeline`, `accessibility`; optional `controls`, `defs`, `simulation`, `referenceChecks`                               |
| State            | Number (`initial`, `min`, `max`, `step`), boolean (`initial`), enum (`initial`, unique `options`); each has a `label`                                                                                 |
| Nodes            | `group`, `rect`, `circle`, `ellipse`, `line`, `text`, structured `path`, `plot`, geometric `link`; from 0.2 `use` (symbol instance) and `equation`; from 0.5 `image`                                  |
| Common node data | Unique `id`; expressions for `x`, `y`, `rotation` in degrees, positive uniform `scale`, `opacity`, boolean `visible`; optional `label`, `fill`, `stroke`, `strokeWidth`, `manipulate`, `clip`, `mask` |
| Paint            | `#rgb`, `#rrggbb`, `#rrggbbaa`, `none`, a fixed two-stop diagonal `{kind:'linear', from, to}` fill, or (0.5) `{kind:'radial', from, to, cx?, cy?, r?}`; solid stroke only                             |
| Rectangle        | `width`, `height`, optional `cornerRadius`; position is top-left                                                                                                                                      |
| Circle / ellipse | `radius` or `width`/`height`; position is center                                                                                                                                                      |
| Text             | Primitive/expression `text`, `fontSize`, `weight: normal/bold`, `align: start/middle/end`; position is baseline                                                                                       |
| Path             | Commands `M`, `L`, `Q`, `C`, `Z`, each with typed numeric/expression coordinates. First command must be `M`. No raw SVG path strings                                                                  |
| Plot             | Bounded point array, increasing `domainX`/`domainY`, `width`/`height`, optional `area`. Values outside the domains fail closed. Positive y is plotted upward                                          |
| Link             | `from`/`to` node IDs and `center/top/right/bottom/left/auto` anchors, optional cubic `bend`, arrow and draw `progress`. Links are geometric connections, **not URL navigation**                       |
| Layout           | Required compact and expanded `width`/`height` plus numeric-property overrides keyed by node ID. Optional `breakpoint` (default 640 container CSS pixels). Same semantic nodes/state in both layouts  |
| Timeline         | Bounded `durationMs`, numeric-property tracks, strictly increasing keyframes, ordered textual cues                                                                                                    |
| Accessibility    | Required meaningful `text`; representative reduced-motion `atMs` and `description`                                                                                                                    |

### Clips, masks, symbols and equations (0.2)

`defs` holds scene-local definitions, referenced by id only (never by URL):

- `defs.clips[]`: `{id, nodes}` of `rect`, `circle`, `ellipse` or `path` nodes. A node with `clip: id` is drawn only inside their union.
- `defs.masks[]`: `{id, nodes}` of `group`, `rect`, `circle`, `ellipse`, `line`, `text`, `path` or `plot` nodes, used as a luminance mask (white shows, black hides; gradient fills fade). A node with `mask: id` is masked.
- `defs.symbols[]`: `{id, width, height, nodes}`, drawn in a `0 0 width height` box. A `use` node (`symbol`, optional `width`/`height`, defaults the symbol's size) draws one instance; `width`/`height` are track/override properties of `use`.

Clip and mask shapes are in scene coordinates, so moving the clipped node does not move its clip. Definition nodes may carry expressions, layout overrides and tracks (an animated clip is a reveal), but no `manipulate`, `link`, `use`, or nested `clip`/`mask`, and links cannot target them. Every reference must resolve (`UNDEFINED_REFERENCE` otherwise). Node ids are unique across the scene and its definitions. Bounds: 32 definitions of each kind, 64 nodes per clip or mask, 64 `use` instances, and 4,000 nodes once every instance expands its symbol (`USE_LIMIT`). Definition nodes count toward the 400-node limit.

`equation` nodes take `tex` (at most 512 characters), optional `fontSize` (default 16, also a track/override property) and `align`, and **require `label`**, the equation's text alternative. `tex` is a constrained TeX subset parsed and laid out by this package (`equation.ts`); no third-party math engine runs. Supported: letters (italic), numbers, `+ - * / = < > ( ) [ ] | , ; : . ! ? '`, groups `{…}`, `^` and `_`, `\frac`/`\dfrac`/`\tfrac`, `\sqrt`, `\text{…}`, `\mathrm`/`\mathbf`/`\mathit`, `\operatorname{…}`, `\hat`/`\bar`/`\vec`/`\tilde`/`\dot`, `\left`/`\right` with a delimiter, spacing (`\, \: \; \! \quad \qquad`), Greek letters, common binary operators and relations, `\sum \prod \int \oint`, and `\sin \cos \tan \log \ln \exp \max \min \lim \det \arg \sup \inf \Pr`. Everything else is refused: macros that define commands or emit links or markup (`\href`, `\url`, `\html…`, `\def`, `\newcommand`, `\let`, `\input`, …) with `EQUATION_UNSAFE`, other macros with `EQUATION_MACRO`, characters such as `$ & # % ~` and non-ASCII with `EQUATION_CHAR`. The layout is deterministic: glyph advances are estimated and each glyph renders with `textLength`, so the result does not depend on the viewer's fonts. In SVG an equation is a `role="img"` group labelled by `label`; the player's text equivalent lists each equation's label and MathML (`equationMathML`).

### Springs, staggers, the layout set and panes (0.3)

- **Springs.** A keyframe with `ease: "spring"` reaches its value along a damped spring. The optional `spring: {stiffness, damping, mass}` defaults to 170, 26 and 1. Bounds keep the integration stable: stiffness 1–1000, damping 0–200, mass 0.1–10, stiffness/mass ≤ 5000 and damping/mass ≤ 200.
  - The spring starts at the previous keyframe's time; hold a value with a plain keyframe to delay it.
  - It is integrated with semi-implicit Euler at a fixed 1/240 s step, using only addition and multiplication, and interpolated linearly between steps. The headless runtime, the server check and every browser therefore compute identical values (`test/motion.test.tsx` pins them; the browser test compares DOM transforms with the headless frame).
  - A segment always ends exactly on its keyframe value. Overshoot is clamped to the property's valid range (opacity and progress 0–1, sizes ≥ 0, scale 0.001–100).
- **Staggers.** `timeline.staggers[]` is `{nodes, property, delayMs, keyframes}`: the same keyframes for each node, the i-th node starting `i × delayMs` later.
  - Each node/property pair counts as a track: it must be supported, must not duplicate another track, and must end within the duration.
- **The four-layout set.** `layouts.tabletPortrait`, `layouts.tabletLandscape` and `layouts.wide`, all three or none, together with `compact`.
  - With the set, the mode follows the player's width at fixed breakpoints (`LAYOUT_SET_BREAKPOINTS`): compact < 600 ≤ tabletPortrait < 905 ≤ tabletLandscape < 1240 ≤ wide.
  - `breakpoint` belongs to the two-layout form and is refused with the set.
  - `expanded` stays required as the fallback the SDK experience carries.
  - Layouts change overrides only, so every layout has the same logical node ids. `layoutWidth(scene, mode)` gives a width that selects a mode, for hosts that receive a mode.
- **Panes.** `panes[]` (at most 8) are HTML panes beside the SVG, evaluated from the same state, time and expressions as the geometry:
  - `table`: `columns`, `rows` of expressions and an optional `highlightRow`, 0-based;
  - `code`: `language`, plain-text `lines` and an optional `highlightLine`, 1-based, with no syntax highlighting and no markup;
  - `formula`: constrained-TeX `tex`, a required `label`, and `values` of `{symbol, value}`.
  - The current row or line carries `aria-current`.
  - The React player and the headless `renderPanes(frame, {idPrefix})` render the same sanitized tree. HTML panes have their own allowlist: tables, lists, code, definition lists and MathML only; no links, scripts, frames or styles.
- **Off-screen pause.** The player pauses playback while it is scrolled out of view (IntersectionObserver) and resumes when it returns. It does not resume when the viewer paused, sought or reset in between, or when reduced motion is preferred. `OffscreenPause` holds this logic without DOM references.

### Publish-time checks, the inspector and device preview (0.4)

- **Invariants** (`invariants[]`, at most 32) are boolean assertions written as data. They use the ordinary expression forms plus probes into the computed frame:
  - `{node, property}`: a computed property, or `worldX`/`worldY` for its scene translation;
  - `{cell: {pane, row, column}}`: the value a table cell evaluates to;
  - `{value: {pane, symbol}}`: a formula pane's value;
  - `{highlight: pane}`: the highlighted row or line, or -1 when nothing is highlighted.

  One assertion can therefore tie the SVG, a trace table and a formula together. Contradictory representations (S05) then fail publication instead of reaching learners.
  - Each invariant runs at every layout the scene has, at its `times` (by default 0, every cue and the duration), for the initial state and each of its `states`.
  - A hidden node or an unknown reference is a failure, never a pass.
  - Probes are accepted only inside invariants.
  - The work is bounded: at most 512 checked frames.

- **Goldens** (`goldens[]`, at most 32) record `{atMs, layout, digest}`.
  - The digest is SHA-256 over what the frame draws: layout, geometry, definitions, panes and text, with numbers to 10 significant digits so platforms agree.
  - A renderer or scene change that moves geometry makes the digests differ.
  - `goldenFrames(scene, times)` produces the digests for authors to embed after reviewing a change.
- `runSceneChecks(scene)` returns every failure with its layout, time and state. `assertSceneChecks(scene)` throws `INVARIANT_FAILED` or `GOLDEN_MISMATCH`.
  - The API runs these checks when it validates a visual. It refuses publication with `PUBLISH_VISUAL_INVARIANT_FAILED` or `PUBLISH_VISUAL_GOLDEN_MISMATCH`, and the details name the check.
- **Named `referenceChecks`** remain host-registered diagnostics. Core has no trusted server registry for them, so the data-only invariants are the enforced form.
- **Trace tables** are `table` panes (0.3), synchronized with the frame and highlighted per step; there is no separate primitive.
- **`VisualInspector`** (from `./react`) is a design-time inspector driving the same runtime as a player. It shows:
  - every state field, not only `controls`;
  - the timeline, with jumps to each keyframe;
  - a selected node's computed properties;
  - a button that runs the scene's checks.
- **`DevicePreview`** renders the runtime's current frame at the widths in `PREVIEW_DEVICES`: phone, tablet portrait, tablet landscape and desktop.
  - It uses `frameAtWidth`, the same replay at another width, and each preview equals the headless export.
  - The widths are player widths. From 0.5 each frame sits in a device frame (phone, tablet or browser window) drawn by CSS and hidden from assistive technology; `chrome={false}` shows the bare frames.

### Images, radial gradients, matrices, morph, colour and camera (0.5)

- **Images.** `defs.images[]` is `{id, mediaType, width, height, sha256, data}`: an embedded PNG, JPEG or WebP (`data` is padded base64, at most 192,000 characters; at most 16 images; the 1 MB scene budget bounds the total). Parsing decodes the data, checks the format signature against `mediaType` and the `sha256` against the bytes (`IMAGE_INVALID`, `IMAGE_DIGEST`), so SVG, HTML or a URL can never pass as an image. An `image` node (`image`, `width`, `height`, `fit: contain | cover | fill`) draws one and **requires `label`**, its text alternative. Images may appear in symbols and masks, never in clips. Frame digests count an image by its sha256. The sanitizer allows `<image>` only with an embedded `data:image/(png|jpeg|webp);base64,…` href.
- **Radial gradients.** A `radial` fill puts the first colour at the centre (`cx`, `cy`, fractions of the node's box, default 0.5) and the second at radius `r` (default 0.5, at most 2). Feature `radial_gradient`.
- **Matrices and environments.** Equations accept `\begin{matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|cases|aligned} … \end{…}`, with `&` between columns and `\\` between rows (at most 16 of each). `&` and `\\` anywhere else are refused, as are other environments (`array`, `tabular`, …). Delimiters are drawn as strokes; MathML uses `mtable`. Feature `equation_environments`.
- **Path morph.** A `path` with `morphTo` (the same command letters, in order) has a `morph` property (0–1; expression, layout override or track): every coordinate is interpolated between the two shapes. Feature `morph`.
- **Colour animation.** `timeline.colorTracks[]` is `{node, property: fill | stroke, keyframes: [{atMs, color, ease?}]}` with solid colours; channels and alpha interpolate in sRGB. A fill track needs a solid fill. Feature `color_animation`.
- **Camera.** `camera: {x?, y?, zoom?}` (expressions; default the layout centre and zoom 1) and `timeline.cameraTracks[]` (`x`, `y`, `zoom`) set the SVG `viewBox`: zoom 0.1–20 about the centre. Geometry, probes, pointer input and clips stay in scene coordinates. Feature `camera`.
- **Export.** `ExportControls` (also inside `VisualInspector`) downloads the current frame as the headless SVG (`renderSvg` with the SVG namespace) or a PNG rasterized from it at twice the layout size (at most 4096 px a side). Files are data URLs saved through a hidden link; nothing is uploaded and no element or object URL is created.
- **Lazy loading and disposal.** `LazyVisualPlayer` parses the scene and creates its runtime only when it comes within `rootMargin` of the area it scrolls in: the nearest vertically scrolling ancestor (so the margin preloads it inside a scrolling lesson pane, from 0.5.1), `scrollRoot` when given, or the viewport; after `disposeAfterMs` (default 60 s) out of that margin it unmounts the player, pauses and releases the runtime, keeping the replay and time to restore later. A placeholder holds the last height and offers a button that loads it at once. `onRuntime` reports the live runtime and `null` after disposal.
- **Completion.** `onComplete` on the players reports the first time the timeline end is shown (by playback or scrubbing), once per runtime: replaying, scrubbing and resetting never report it again (`CompletionLatch`). It is an observation for the host to record, never evidence. Core records it at most once per learner, course version and block (`POST /api/enrollments/:id/visual-completions`).
- **Messages.** See `docs/i18n.md`: `messages` and `locale` props, `englishVisualMessages`, and catalog errors with `key` and `params`.

  0.4 scenes keep their frames, markup and golden digests: a scene without these fields produces exactly the frame it did.

### Render features

`sceneFeatures(scene)` lists what a scene needs from a renderer: SDK `RenderFeature` values `gradient`, `path_draw`, `clip`, `mask`, `equation`, plus `symbol`, `spring`, `stagger`, `layout_set`, `panes`, `invariants`, `goldens`, `image`, `radial_gradient`, `equation_environments`, `morph`, `color_animation` and `camera` (not yet in the released SDK enum). `SUPPORTED_FEATURES` lists what this build implements. The API refuses at publication (`PUBLISH_RENDER_FEATURE_UNSUPPORTED`, with the missing and supported features) a visual, or an SDK renderer definition with `surface: "visual"`, that needs a feature the declared renderer build lacks.

### SVG output, sanitizing and export

The React `SceneView` and the headless `renderSvg(frame, {idPrefix, title})` render the same element tree (`buildSceneMarkup`), so headless export and the browser produce identical markup (`test/primitives.test.tsx` compares them). Every id is prefixed per scene instance (`useId` in React, `idPrefix` for export), so two scenes with the same definition ids can share a page. `sanitizeMarkup` checks the tree against an allowlist before anything renders: known SVG and MathML elements and attributes only (no `script`, `foreignObject`, event handlers or `style` other than the root aspect ratio), finite numbers, unique ids, `href` only to a `symbol` in the same tree, and `url(#…)` paints, clips, masks and markers only to elements of the matching kind in the same tree. Text is escaped exactly as React escapes it. Pass `xmlns: true` for a standalone `.svg` file.

Numeric track/override properties: `x`, `y`, `rotation`, `scale`, `opacity`, `width`, `height`, `radius`, `fontSize`, `x2`, `y2`, `progress`, and (0.5) `morph`. A property must belong to the target node kind. Tracks take precedence over layout overrides, which take precedence over node values. Layout-specific animated distances can be expressed through parent transforms. Links use world geometry and cannot carry transforms or manipulation. Group bounds union child geometry, excluding links; stroke/markers do not expand bounds. `auto` link anchors choose the facing edges of target bounds for horizontal/vertical reflow.

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

The parser rejects cycles, prototype keys, accessors, non-JSON objects, unknown node kinds/operators/fields, unresolved references, duplicate IDs/tracks, malformed timelines, nonfinite numbers, unsafe paints and raw executable data. Dynamic values are checked again when evaluated. Invalid runtime changes fail closed with a readable UI message and last-valid-frame preservation. There is no `eval`, `new Function`, author JavaScript, arbitrary HTML/SVG markup, resource URL, remote image loading or external navigation field; images are embedded, digest-checked raster data only. Screenshots are verification artifacts only; they are never executable input. Pass JSON data rather than live objects with proxies; code already able to create a Proxy in the host is outside the scene-data trust boundary.

## Accessibility and fallback

Every scene needs a useful textual equivalent. The player exposes a description, all authored cues, current primitive state, readable labels, focus outlines and keyboard-operable controls. Reduced motion starts at the authored representative frame, disables automatic playback, expands the text equivalent and retains discrete seeking/manipulation. Changing the media preference stops playback. Live announcements are quiet during playback. The renderer escapes text and generates scoped internal gradient, marker, clip, mask and symbol IDs. It uses SVG/HTML, never an arbitrary app-canvas script.

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
