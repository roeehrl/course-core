import type { YTNamespace } from "../src/components/YouTubePlayer.web";
import { resetYouTubeApiForTests } from "../src/components/YouTubePlayer.web";

export interface FakePlayerCall {
  host: string;
  videoId: string;
  playerVars: Record<string, string | number>;
}
/** A stand-in for the IFrame Player API: builds the iframe the real API would,
 * records the options and fires the configured onError code. No network. */
export function installFakeYouTube(errorCode?: number) {
  resetYouTubeApiForTests();
  const calls: FakePlayerCall[] = [];
  const destroyed: string[] = [];
  const YT: YTNamespace = {
    Player: class {
      #frame: HTMLIFrameElement;
      constructor(element: HTMLElement, options: ConstructorParameters<YTNamespace["Player"]>[1]) {
        calls.push({ host: options.host, videoId: options.videoId, playerVars: options.playerVars });
        this.#frame = document.createElement("iframe");
        this.#frame.src = `${options.host}/embed/${options.videoId}?enablejsapi=1`;
        element.replaceWith(this.#frame);
        queueMicrotask(() =>
          errorCode === undefined
            ? options.events.onReady?.({ target: this })
            : options.events.onError?.({ target: this, data: errorCode }),
        );
      }
      getIframe() {
        return this.#frame;
      }
      destroy() {
        destroyed.push(this.#frame.src);
        this.#frame.remove();
      }
    },
  };
  window.YT = YT;
  return { calls, destroyed, remove: () => { delete window.YT; resetYouTubeApiForTests(); } };
}
