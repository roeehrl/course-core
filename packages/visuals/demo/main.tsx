import { useState } from "react";
import { createRoot } from "react-dom/client";
import { VisualPlayer } from "../src/react.js";
import {
  demoScenes,
  demoReferenceChecks,
  primitivesDemo,
} from "../src/demos.js";
import "../src/styles.css";
import "./gallery.css";
const scenes = [...demoScenes, primitivesDemo];
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
createRoot(document.getElementById("root")!).render(
  location.hash === "#pair" ? <Pair /> : <Gallery />,
);
