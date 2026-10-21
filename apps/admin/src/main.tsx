import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { ConnectedHost } from "./ConnectedHost";
import { useT } from "./i18n";
import { LocaleProvider } from "./i18n/LocaleProvider";
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
import { installImeSubmitGuard } from "./client/imeGuard";

// An Enter that commits IME composition never submits a form (I06).
installImeSubmitGuard();
function Opening({ demo }: { demo?: boolean }) {
  const t = useT();
  return <p>{t(demo ? "main.openingDemo" : "main.openingInspector")}</p>;
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LocaleProvider>
      {/^\/admin\/inspector\/?$/.test(window.location.pathname) ? (
        <Suspense fallback={<Opening />}>
          <EmbeddedInspector />
        </Suspense>
      ) : /^\/admin\/demo\/?$/.test(window.location.pathname) ? (
        <Suspense fallback={<Opening demo />}>
          <DemoHost />
        </Suspense>
      ) : (
        <ConnectedHost />
      )}
    </LocaleProvider>
  </StrictMode>,
);
