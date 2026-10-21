import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  DevicePreview,
  LazyVisualPlayer,
  VisualInspector,
  VisualPlayer,
  VisualRuntimePlayer,
} from "../src/react.js";
import { VisualRuntime } from "../src/runtime.js";
import {
  demoScenes,
  demoReferenceChecks,
  primitivesDemo,
  motionStudyDemo,
  lensDemo,
} from "../src/demos.js";
import "../src/styles.css";
import "./gallery.css";
const scenes = [...demoScenes, primitivesDemo, motionStudyDemo, lensDemo];
function Gallery() {
  const [selected, setSelected] = useState(0);
  return (
    <main className="gallery">
      <nav className="brand">
        <a href="#main">
          course core <span>／ visual studies</span>
        </a>
        <span className="edition">OPEN STUDIES · VOL. 01</span>
      </nav>
      <header className="intro" id="main">
        <div className="intro-tag">
          <span /> A playground for understanding
        </div>
        <h1>
          See the idea.
          <br />
          <em>Make it move.</em>
        </h1>
        <p>
          Beautiful little systems for big moments of understanding.
          <br className="desktop-break" /> Touch, change, rewind. There is more
          than one way to learn.
        </p>
        <div className="intro-meta">
          <span>01—03 / OPEN EXPLORATIONS</span>
          <span>DESIGNED FOR CURIOSITY ↘</span>
        </div>
      </header>
      <div className="study-tabs" role="tablist" aria-label="Visual studies">
        {[
          "01 · Order & motion",
          "02 · Curves & possibility",
          "03 · States & transitions",
          "04 · Clip, mask & equations",
          "05 · Springs, stagger & panes",
          "06 · Zoom, morph & colour",
        ].map((name, i) => (
          <button
            role="tab"
            key={name}
            id={`study-tab-${i}`}
            aria-selected={selected === i}
            aria-controls="study-panel"
            tabIndex={selected === i ? 0 : -1}
            onClick={() => setSelected(i)}
            onKeyDown={(e) => {
              if (["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) {
                e.preventDefault();
                const next =
                  e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? scenes.length - 1
                      : (selected +
                          (e.key === "ArrowRight" ? 1 : scenes.length - 1)) %
                        scenes.length;
                setSelected(next);
                document.getElementById(`study-tab-${next}`)?.focus();
              }
            }}
          >
            {name}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id="study-panel"
        aria-labelledby={`study-tab-${selected}`}
      >
        <VisualPlayer
          key={selected}
          scene={scenes[selected]}
          options={{ referenceChecks: demoReferenceChecks }}
        />
      </div>
      <footer className="gallery-footer">
        <span>Responsive by design. Accessible by intention.</span>
        <span>DATA → GEOMETRY → UNDERSTANDING</span>
      </footer>
    </main>
  );
}
/** Two scenes with the same clip/mask/symbol ids on one page: their ids must not collide. */
const copy = {
  ...primitivesDemo,
  title: `${primitivesDemo.title} (second copy)`,
};
function Pair() {
  return (
    <main className="gallery">
      <h1>Two instances</h1>
      <VisualPlayer scene={primitivesDemo} />
      <VisualPlayer scene={copy} />
    </main>
  );
}
/** A player followed by a long page, to scroll it out of view while it plays. */
function Offscreen() {
  return (
    <main className="gallery">
      <h1>Off-screen pause</h1>
      <VisualPlayer scene={motionStudyDemo} />
      <div style={{ height: "300vh" }} aria-hidden="true" />
      <p id="page-end">End of page.</p>
    </main>
  );
}
/** Author tools: the player, its parameter inspector and a multi-device preview, sharing one runtime. */
function Tools({ scene }: { scene: typeof motionStudyDemo }) {
  const [runtime] = useState(() => new VisualRuntime(scene));
  return (
    <main className="gallery">
      <h1>Author tools</h1>
      <VisualRuntimePlayer runtime={runtime} />
      <VisualInspector runtime={runtime} />
      <DevicePreview runtime={runtime} />
    </main>
  );
}
/** Completion is reported once, whatever the viewer replays or scrubs afterwards. */
function Completion() {
  const [count, setCount] = useState(0);
  return (
    <main className="gallery">
      <h1>Completion</h1>
      <p id="completions">Completions: {count}</p>
      <VisualPlayer
        scene={lensDemo}
        onComplete={() => setCount((n) => n + 1)}
      />
    </main>
  );
}
/** A lazily loaded player far down the page, disposed shortly after it leaves the view. */
function Lazy() {
  const [state, setState] = useState("none");
  const [count, setCount] = useState(0);
  const [eager, setEager] = useState(false);
  return (
    <main className="gallery">
      <h1>Lazy loading</h1>
      <p id="runtime-state">Runtime: {state}</p>
      <label>
        <input
          type="checkbox"
          checked={eager}
          onChange={(e) => setEager(e.target.checked)}
        />{" "}
        Keep loaded (as while inspecting)
      </label>
      <p id="completions">Completions: {count}</p>
      <div style={{ height: "250vh" }} aria-hidden="true" />
      <LazyVisualPlayer
        scene={lensDemo}
        rootMargin="0px"
        disposeAfterMs={300}
        eager={eager}
        placeholder={<p>{lensDemo.accessibility.text}</p>}
        onRuntime={(runtime) => setState(runtime ? "live" : "disposed")}
        onComplete={() => setCount((n) => n + 1)}
      />
      <div style={{ height: "250vh" }} aria-hidden="true" />
    </main>
  );
}
/** A lazy player inside a scrolling container, like a lesson pane that scrolls on its own. */
function LazyInContainer() {
  const [state, setState] = useState("none");
  return (
    <main className="gallery">
      <h1>Lazy loading in a scrolling pane</h1>
      <p id="runtime-state">Runtime: {state}</p>
      <div
        id="pane"
        style={{ height: 300, overflowY: "auto", border: "1px solid" }}
      >
        <div style={{ height: 1200 }} aria-hidden="true" />
        <LazyVisualPlayer
          scene={lensDemo}
          rootMargin="400px 0px"
          disposeAfterMs={300}
          onRuntime={(runtime) => setState(runtime ? "live" : "disposed")}
        />
        <div style={{ height: 1200 }} aria-hidden="true" />
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  location.hash === "#pair" ? (
    <Pair />
  ) : location.hash === "#offscreen" ? (
    <Offscreen />
  ) : location.hash === "#inspector" ? (
    <Tools scene={motionStudyDemo} />
  ) : location.hash === "#inspector-state" ? (
    <Tools scene={primitivesDemo} />
  ) : location.hash === "#inspector-lens" ? (
    <Tools scene={lensDemo} />
  ) : location.hash === "#completion" ? (
    <Completion />
  ) : location.hash === "#lazy" ? (
    <Lazy />
  ) : location.hash === "#lazy-pane" ? (
    <LazyInContainer />
  ) : (
    <Gallery />
  ),
);
