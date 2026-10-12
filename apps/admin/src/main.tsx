import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { ConnectedHost } from "./ConnectedHost";
const DemoHost = lazy(() =>
  import("./DemoHost").then((module) => ({ default: module.DemoHost })),
);
import "./styles.css";
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/^\/admin\/demo\/?$/.test(window.location.pathname) ? (
      <Suspense fallback={<p>Opening explicit demo…</p>}>
        <DemoHost />
      </Suspense>
    ) : (
      <ConnectedHost />
    )}
  </StrictMode>,
);
