import { useMemo } from "react";
import type { VisualMessages } from "@course-core/visuals/headless";
import { useI18n, type MessageKey } from "../i18n";

/**
 * The visuals player's texts in the UI language (visuals 0.5 `messages`), from this app's
 * `visualMessages` catalog, plus the locale for its numbers. Scene text is course content
 * and keeps the course language.
 */
export function useVisualMessages(): {
  messages: Partial<VisualMessages>;
  locale: string;
} {
  const i18n = useI18n();
  return useMemo(() => {
    const t = i18n.t;
    const messages: Partial<VisualMessages> = {
      layout: {
        compact: t("visualMessages.layout.compact"),
        expanded: t("visualMessages.layout.expanded"),
        tabletPortrait: t("visualMessages.layout.tabletPortrait"),
        tabletLandscape: t("visualMessages.layout.tabletLandscape"),
        wide: t("visualMessages.layout.wide"),
      },
      invalidScene: t("visualMessages.invalidScene"),
      eyebrow: t("visualMessages.eyebrow"),
      stillMode: t("visualMessages.stillMode"),
      liveCanvas: t("visualMessages.liveCanvas"),
      stepError: t("visualMessages.stepError"),
      play: t("visualMessages.play"),
      pause: t("visualMessages.pause"),
      playAnimation: t("visualMessages.playAnimation"),
      pauseAnimation: t("visualMessages.pauseAnimation"),
      timeline: t("visualMessages.timeline"),
      timeReadout: (current, total) =>
        t("visualMessages.timeReadout", { current, total }),
      timelineValue: (seconds, cue) =>
        t("visualMessages.timelineValue", { seconds, cue }),
      seconds: (value) => t("visualMessages.seconds", { value }),
      milliseconds: (value) => t("visualMessages.milliseconds", { value }),
      reset: t("visualMessages.reset"),
      exploreState: t("visualMessages.exploreState"),
      textEquivalent: t("visualMessages.textEquivalent"),
      reducedMotionEnabled: t("visualMessages.reducedMotionEnabled"),
      equations: t("visualMessages.equations"),
      dragHint: t("visualMessages.dragHint"),
      lazyPlaceholder: t("visualMessages.lazyPlaceholder"),
      lazyLoad: t("visualMessages.lazyLoad"),
      // Visuals errors and check failures carry a catalog key and parameters (visuals 0.5.2): word
      // them from this app's visualErrors catalog, or show the English message for a key it lacks.
      describeError: (error) => {
        if (!error.key) return error.message;
        const key = `visualErrors.error.${error.key}` as MessageKey;
        return i18n.has(key) ? t(key, error.params) : error.message;
      },
    };
    return { messages, locale: i18n.locale };
  }, [i18n]);
}
