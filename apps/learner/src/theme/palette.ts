/**
 * The learner app's colours, light and dark (docs: final design §1.1). `src/connected/styles/tokens.css`
 * declares the same values as CSS custom properties; tests/tokens.test.ts keeps the two equal and
 * checks every contrast pair in both themes. React Native styles read the hex values through
 * `./colors`; web styles get `var(--token)` strings from `./colors.web`.
 */
export const TOKENS = {
  page: "--page",
  surface: "--surface",
  surface2: "--surface-2",
  ink: "--ink",
  inkMuted: "--ink-muted",
  line: "--line",
  lineStrong: "--line-strong",
  bubble: "--bubble",
  accent: "--accent",
  accentHover: "--accent-hover",
  onAccent: "--on-accent",
  accentSoft: "--accent-soft",
  companion: "--companion",
  danger: "--danger",
  onDanger: "--on-danger",
  focus: "--focus",
  sendOff: "--send-off",
  // Base app (non-AI surfaces): lesson warnings, the media stage, dialog backdrop, translucent header.
  warning: "--warning",
  warningSoft: "--warning-soft",
  stage: "--stage",
  onStage: "--on-stage",
  backdrop: "--backdrop",
  header: "--header",
} as const;

export type ColorToken = keyof typeof TOKENS;
export type Theme = "light" | "dark";

export const palette: Readonly<Record<Theme, Readonly<Record<ColorToken, string>>>> = {
  light: {
    page: "#F8F8F2",
    surface: "#FFFFFF",
    surface2: "#F1F4F3",
    ink: "#183237",
    inkMuted: "#526A70",
    line: "#E3EAE7",
    lineStrong: "#74878A",
    bubble: "#EDF3F0",
    accent: "#087B69",
    accentHover: "#066456",
    onAccent: "#FFFFFF",
    accentSoft: "#E8F6ED",
    companion: "#7050A4",
    danger: "#A4262C",
    onDanger: "#FFFFFF",
    focus: "#183237",
    sendOff: "#E3EAE7",
    warning: "#80601E",
    warningSoft: "#FCF3DF",
    stage: "#19383E",
    onStage: "#FFFFFF",
    backdrop: "#18323766",
    header: "#FFFFFFDF",
  },
  dark: {
    page: "#0F1517",
    surface: "#151C1E",
    surface2: "#1D2729",
    ink: "#E6EEEC",
    inkMuted: "#A3B5B8",
    line: "#24302F",
    lineStrong: "#687C7F",
    bubble: "#24302F",
    accent: "#4CC7AE",
    accentHover: "#6FD6C0",
    onAccent: "#0E1A18",
    accentSoft: "#1F3A33",
    companion: "#B9A0E8",
    danger: "#F19A93",
    onDanger: "#0E1A18",
    focus: "#E6EEEC",
    sendOff: "#24302F",
    warning: "#E6C27A",
    warningSoft: "#2B2416",
    stage: "#0B1214",
    onStage: "#FFFFFF",
    backdrop: "#00000099",
    header: "#151C1EDF",
  },
};

/** Elevation (§1.3): the shadows `tokens.css` declares as `--shadow-menu`, `--shadow-sheet`, `--shadow-jump`. */
export const shadows: Readonly<Record<Theme, Readonly<Record<"menu" | "sheet" | "jump", string>>>> = {
  light: {
    menu: "0 4px 16px rgba(24, 50, 55, 0.15)",
    sheet: "0 -1px 0 var(--line), 0 -8px 32px rgba(24, 50, 55, 0.12)",
    jump: "0 2px 8px rgba(24, 50, 55, 0.16)",
  },
  dark: {
    menu: "0 4px 16px rgba(0, 0, 0, 0.5)",
    sheet: "0 -1px 0 var(--line), 0 -8px 32px rgba(0, 0, 0, 0.5)",
    jump: "0 2px 8px rgba(0, 0, 0, 0.5)",
  },
};
