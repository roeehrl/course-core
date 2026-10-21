import { useRef, useState, useSyncExternalStore } from "react";
import { visualMessages } from "./messages.js";
import type { VisualMessages } from "./messages.js";
import type { VisualRuntime } from "./runtime.js";
import { renderSvg } from "./svg.js";

/** A download name for the runtime's current frame: `<scene>-<time>ms.<ext>`. */
export function exportFileName(
  sceneId: string,
  timeMs: number,
  extension: "svg" | "png",
): string {
  return `${sceneId}-${Math.round(timeMs)}ms.${extension}`;
}

/** Saves a data URL through the component's own hidden link: no element or object URL is created. */
function download(link: HTMLAnchorElement | null, href: string, name: string) {
  if (!link) throw new Error(name);
  link.href = href;
  link.download = name;
  link.click();
  link.removeAttribute("href");
}
const svgDataUrl = (text: string) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
/** Largest PNG side, in pixels. */
const MAX_PNG_SIDE = 4096;

/**
 * Downloads the runtime's current frame (0.5). SVG is the headless export (`renderSvg`
 * with the SVG namespace), byte for byte what the player draws without its handlers. PNG
 * rasterizes that same SVG in the browser at `scale` times its layout size (at most 4096
 * pixels a side). Nothing is uploaded: the file is a data URL saved through a hidden link
 * the component renders, so no element, object URL or script is created.
 */
export function ExportControls({
  runtime,
  messages,
  scale = 2,
}: {
  runtime: VisualRuntime;
  messages?: Partial<VisualMessages>;
  scale?: number;
}) {
  const m = visualMessages(messages);
  const { frame } = useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
    runtime.getSnapshot,
  );
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const link = useRef<HTMLAnchorElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const svgText = () =>
    renderSvg(frame, {
      idPrefix: "export",
      title: runtime.scene.title,
      xmlns: true,
    });
  const saveSvg = () => {
    try {
      const name = exportFileName(runtime.scene.id, frame.timeMs, "svg");
      download(link.current, svgDataUrl(svgText()), name);
      setStatus({ ok: true, text: m.exportDone(name) });
    } catch {
      setStatus({ ok: false, text: m.exportFailed });
    }
  };
  const savePng = () => {
    const name = exportFileName(runtime.scene.id, frame.timeMs, "png");
    const fail = () => setStatus({ ok: false, text: m.exportFailed });
    try {
      const image = new Image();
      image.onload = () => {
        try {
          const canvas = canvasRef.current;
          if (!canvas) return fail();
          const k = Math.min(
            scale,
            MAX_PNG_SIDE / Math.max(frame.width, frame.height),
          );
          canvas.width = Math.round(frame.width * k);
          canvas.height = Math.round(frame.height * k);
          const context = canvas.getContext("2d");
          if (!context) return fail();
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          download(link.current, canvas.toDataURL("image/png"), name);
          setStatus({ ok: true, text: m.exportDone(name) });
        } catch {
          fail();
        }
      };
      image.onerror = fail;
      image.src = svgDataUrl(svgText());
    } catch {
      fail();
    }
  };
  return (
    <div className="ccv-export" role="group" aria-label={m.exportHeading}>
      <button type="button" onClick={saveSvg}>
        {m.downloadSvg}
      </button>
      <button type="button" onClick={savePng}>
        {m.downloadPng}
      </button>
      <a ref={link} hidden aria-hidden="true" tabIndex={-1} />
      <canvas ref={canvasRef} hidden aria-hidden="true" />
      <p
        role="status"
        className={status && !status.ok ? "ccv-export-error" : undefined}
      >
        {status?.text}
      </p>
    </div>
  );
}
