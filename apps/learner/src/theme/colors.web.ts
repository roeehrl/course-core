import "../connected/styles/tokens.css";
import { TOKENS, type ColorToken } from "./palette";

/**
 * Colours for react-native-web styles: CSS custom properties from `tokens.css` (react-native-web
 * passes `var()` through), so a style follows the light or dark theme without a re-render.
 */
export const colors = Object.fromEntries(
  (Object.keys(TOKENS) as ColorToken[]).map((key) => [key, `var(${TOKENS[key]})`]),
) as Readonly<Record<ColorToken, string>>;
