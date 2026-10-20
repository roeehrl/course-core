import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { ConnectedHost } from "./ConnectedHost";
const DemoHost = lazy(() =>
  import("./DemoHost").then((module) => ({ default: module.DemoHost })),
);
// The debug inspector the learner app frames beside an activity (served at /admin/inspector).
const EmbeddedInspector = lazy(() =>
  import("./components/EmbeddedInspector").then((module) => ({
    default: module.EmbeddedInspector,
  })),
);
import "./styles.css";
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/^\/admin\/inspector\/?$/.test(window.location.pathname) ? (
      <Suspense fallback={<p>Opening the debug inspector…</p>}>
        <EmbeddedInspector />
      </Suspense>
    ) : /^\/admin\/demo\/?$/.test(window.location.pathname) ? (
      <Suspense fallback={<p>Opening explicit demo…</p>}>
        <DemoHost />
      </Suspense>
    ) : (
      <ConnectedHost />
    )}
  </StrictMode>,
);
