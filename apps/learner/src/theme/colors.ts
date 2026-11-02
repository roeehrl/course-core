import { palette, type ColorToken } from "./palette";

/**
 * Colours for React Native styles: hex values from the palette. The web build resolves
 * `./colors.web` instead, whose values are `var(--token)` strings, so web pages follow the
 * page's theme. Both export the same keys.
 */
export const colors: Readonly<Record<ColorToken, string>> = palette.light;
