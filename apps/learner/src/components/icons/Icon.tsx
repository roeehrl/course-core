import type { CSSProperties } from "react";
import type { IconName, IconSize } from "./icons";

export interface IconProps {
  name: IconName;
  /** 16 in action rows and meta lines, 18 inside Send and Stop, 20 elsewhere (the default). */
  size?: IconSize;
  className?: string;
  style?: CSSProperties;
}

/**
 * The icon set is drawn as inline SVG on the web (`Icon.web.tsx`). React Native screens have no
 * SVG renderer in this app yet, so the native build draws nothing: every icon is decorative and
 * its control carries the words.
 */
export function Icon(_props: IconProps): null {
  return null;
}
