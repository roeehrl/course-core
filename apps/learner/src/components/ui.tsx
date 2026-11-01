import React, { useState } from "react";
import { useI18n } from "../i18n";
import { LivePressable } from "./LivePressable";
import {
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { colors as theme } from "../theme/colors";
import type { ColorToken } from "../theme/palette";

/**
 * The app's colours under their historical names, each one a design token (final design §1.1):
 * hex values on native, `var(--token)` strings on web, so a web page follows the light or dark
 * theme. There are no lilac fills any more (`lilac` is the neutral second surface) and purple is
 * the companion glyph's colour only.
 */
export const colors = {
  paper: theme.page,
  white: theme.surface,
  ink: theme.ink,
  muted: theme.inkMuted,
  line: theme.line,
  teal: theme.accent,
  mint: theme.accentSoft,
  purple: theme.companion,
  lilac: theme.surface2,
  gold: theme.warning,
  sand: theme.warningSoft,
  stage: theme.stage,
};
/** The focus ring of every control drawn here: a 2 px `--focus` outline, never a border or shadow
 * alone, so forced colours keep it (final design §6). React Native draws no outline; there the
 * border change of each control shows focus. */
const focusRing: ViewStyle = Platform.OS === "web"
  ? ({ outlineStyle: "solid", outlineWidth: 2, outlineColor: theme.focus, outlineOffset: 2 } as ViewStyle)
  : {};
export const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    flexWrap: "wrap",
  },
  spread: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    flexWrap: "wrap",
  },
  body: { color: colors.muted, fontSize: 16, lineHeight: 25 },
  small: { color: colors.muted, fontSize: 13, lineHeight: 20 },
  title: {
    color: colors.ink,
    fontSize: 28,
    fontWeight: "700",
    lineHeight: 34,
    letterSpacing: -0.8,
  },
  heading: {
    color: colors.ink,
    fontSize: 19,
    fontWeight: "600",
    lineHeight: 26,
  },
  /** Use `<Eyebrow>`: the small sentence-case label above a heading (13/20 muted, 14/22 in Hebrew). */
  eyebrow: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 20,
    fontWeight: "400",
  },
  /** Tracked Latin capitals. The final design has no uppercase tracked labels (COPY-9), so
   * `<Eyebrow>` no longer applies it; kept for code that still names it. */
  latinCaps: {
    letterSpacing: 1.7,
    textTransform: "uppercase",
  },
  normalTracking: { letterSpacing: 0 },
  card: {
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 20,
    padding: 24,
    gap: 14,
  },
  divider: { height: 1, backgroundColor: colors.line },
});
const buttonBox: ViewStyle = {
  minHeight: 48,
  minWidth: 48,
  paddingHorizontal: 18,
  paddingVertical: 12,
  borderWidth: 2,
  borderRadius: 12,
  justifyContent: "center",
  alignItems: "center",
};
const buttonLabel: TextStyle = {
  fontSize: 14,
  lineHeight: 21,
  fontWeight: "600",
  textAlign: "center",
};
/** Whether a control that just took focus shows its focus ring: always on native; on web only for
 * :focus-visible (keyboard focus), as the stylesheets' rings do. */
function showsFocus(event: unknown): boolean {
  if (Platform.OS !== "web") return true;
  const target = (event as { target?: unknown; nativeEvent?: { target?: unknown } }).nativeEvent?.target ?? (event as { target?: unknown }).target;
  try {
    return !(target instanceof Element) || target.matches(":focus-visible");
  } catch {
    return true;
  }
}
const HEBREW_LETTER = /[\u0590-\u05ff]/;
/** The plain text among a label's children (strings and numbers). */
function plainText(children: React.ReactNode): string {
  return React.Children.toArray(children)
    .map((child) => (typeof child === "string" || typeof child === "number" ? String(child) : ""))
    .join("");
}
/** Text set as Hebrew: a Hebrew interface, or a label or heading in Hebrew (course text). */
function useHebrew(children: React.ReactNode): boolean {
  return useI18n().locale === "he" || HEBREW_LETTER.test(plainText(children));
}
/**
 * The small label above a heading, in sentence case with no tracking in every script (final
 * design §1.2, COPY-9). Hebrew, a Hebrew interface or a label in Hebrew (course text), gets the
 * 14 px floor for text that carries meaning.
 */
export function Eyebrow({ style, children, ...props }: TextProps) {
  const hebrew = useHebrew(children);
  return (
    <Text {...props} style={[styles.eyebrow, styles.normalTracking, hebrew && hebrewMeta, style]}>
      {children}
    </Text>
  );
}
const hebrewMeta: TextStyle = { fontSize: 14, lineHeight: 22 };
/**
 * A heading. Large Latin headings are drawn a little tighter (a negative `letterSpacing` in their
 * style); Hebrew letters set that close run into each other, so in a Hebrew interface, or for a
 * Hebrew heading, it keeps normal spacing. This is the React Native counterpart of the
 * stylesheets' `:lang(he)` resets: on web these styles are inline, which no stylesheet out-ranks.
 */
export function Heading({ style, children, ...props }: TextProps) {
  const hebrew = useHebrew(children);
  return (
    <Text {...props} style={[style, hebrew && styles.normalTracking]}>
      {children}
    </Text>
  );
}

/** The tokens a disabled button is drawn with: the empty Send fill and muted ink. Its label keeps
 * at least 4.5:1 on the fill and on every surface it sits on, in both themes
 * (tests/disabledContrast.test.ts reads them from the palette). */
export const DISABLED_TOKENS = { fill: "sendOff", onFill: "inkMuted", line: "line", text: "inkMuted" } as const satisfies Record<string, ColorToken>;
/** A disabled button's colours (see DISABLED_TOKENS). */
export const DISABLED = {
  fill: theme[DISABLED_TOKENS.fill],
  onFill: theme[DISABLED_TOKENS.onFill],
  line: theme[DISABLED_TOKENS.line],
  text: theme[DISABLED_TOKENS.text],
} as const;
export function Button({
  label,
  onPress,
  kind = "secondary",
  disabled,
  style,
  accessibilityLabel,
  selected,
  testID,
  accessibilityHint,
  describedBy,
  usability,
}: {
  label: string;
  onPress: () => void;
  kind?: "primary" | "secondary" | "quiet";
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  selected?: boolean;
  testID?: string;
  /** Read after the label by native screen readers. */
  accessibilityHint?: string;
  /** On web, the id of visible text that describes the button. */
  describedBy?: string;
  /** Study usability timing (connected/usability.ts): this is the place's required next step,
   * or it leaves the lesson for help. */
  usability?: "next" | "detour";
}) {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  // LivePressable: a press right after this button is enabled (or given a new action) is taken.
  return (
    <LivePressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      {...(Platform.OS === "web" && describedBy ? { "aria-describedby": describedBy } : {})}
      {...(Platform.OS === "web" && usability ? { dataSet: { usability } } : {})}
      accessibilityState={{
        disabled: !!disabled,
        ...(Platform.OS !== "web" && selected !== undefined
          ? { selected }
          : {}),
      }}
      {...(Platform.OS === "web" ? { "aria-pressed": selected } : {})}
      aria-disabled={!!disabled}
      disabled={disabled}
      onPress={onPress}
      onFocus={(event) => setFocused(showsFocus(event))}
      onBlur={() => setFocused(false)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      // A disabled button reads as inactive (flat, muted colours) while its label keeps a contrast
      // of at least 4.5:1; fading the whole button left white on pale teal at about 2:1.
      style={({ pressed }) => [
        {
          ...buttonBox,
          backgroundColor:
            kind === "primary"
              ? disabled ? DISABLED.fill : hovered || pressed ? theme.accentHover : colors.teal
              : kind === "quiet"
                ? "transparent"
                : colors.white,
          // Outline buttons keep a 3:1 border (--line-strong); native shows focus with an ink border.
          borderColor: focused && Platform.OS !== "web"
            ? colors.ink
            : kind === "primary"
              ? disabled ? DISABLED.fill : hovered || pressed ? theme.accentHover : colors.teal
              : kind === "quiet"
                ? "transparent"
                : disabled ? DISABLED.line : theme.lineStrong,
        },
        focused && focusRing,
        (hovered || pressed) &&
          !disabled &&
          kind !== "primary" && { backgroundColor: colors.mint },
        style,
      ]}
    >
      <Text
        style={[
          buttonLabel,
          { color: disabled ? (kind === "primary" ? DISABLED.onFill : DISABLED.text) : kind === "primary" ? theme.onAccent : colors.teal },
        ]}
      >
        {label}
      </Text>
    </LivePressable>
  );
}
/** An inert block with a one-line Button's box, kept in the layout while the
 * action it stands for is loading so that nothing below moves when the real
 * button replaces it. Hidden from assistive technology: the loading status is
 * announced by the indicator beside it, and it has no label or action. */
export function ButtonPlaceholder() {
  return (
    <View
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        buttonBox,
        { borderColor: colors.line, backgroundColor: colors.paper },
      ]}
    >
      <Text style={buttonLabel}>{"\u00a0"}</Text>
    </View>
  );
}
const badgePadding = 5,
  badgeLine = 18;
/** Holds a Badge's height while its value loads; its child (usually a loading
 * indicator) is centred in that space. */
export function BadgeSlot({ children }: { children: React.ReactNode }) {
  return (
    <View
      style={{
        minHeight: badgePadding * 2 + badgeLine,
        justifyContent: "center",
        alignSelf: "flex-start",
      }}
    >
      {children}
    </View>
  );
}
export function Badge({
  label,
  tone = "mint",
}: {
  label: string;
  tone?: "mint" | "lilac" | "sand" | "neutral";
}) {
  // Purple is the companion glyph's colour only, never text on a fill: the former lilac tone is
  // ink on the second surface (final design §1.1).
  const pair = {
    mint: [colors.mint, colors.teal],
    lilac: [colors.lilac, colors.ink],
    sand: [colors.sand, colors.gold],
    neutral: [colors.paper, colors.muted],
  }[tone];
  return (
    <View
      style={{
        backgroundColor: pair[0],
        // A transparent border: forced colours draw it, so the badge keeps its edge there.
        borderWidth: 1,
        borderColor: "transparent",
        borderRadius: 7,
        paddingHorizontal: 9,
        paddingVertical: badgePadding - 1,
        alignSelf: "flex-start",
      }}
    >
      <Text
        style={{
          color: pair[1],
          fontSize: 12,
          fontWeight: "600",
          lineHeight: badgeLine,
        }}
      >
        {label}
      </Text>
    </View>
  );
}
/** A message in the page. `error` is an alert (something failed and needs the learner); `warning`
 * tells of an outcome that did not go the learner's way, such as an answer that did not pass or ran
 * out of time, in the same amber without interrupting; the default is a calm confirmation. */
export function Notice({
  children,
  error = false,
  tone = error ? "error" : "info",
}: {
  children: React.ReactNode;
  error?: boolean;
  tone?: "info" | "warning" | "error";
}) {
  const amber = tone !== "info";
  return (
    <View
      accessibilityRole={tone === "error" ? "alert" : undefined}
      accessibilityLiveRegion="polite"
      aria-live={tone === "error" ? "assertive" : "polite"}
      {...(Platform.OS === "web" ? ({ dataSet: { tone } } as object) : {})}
      style={{
        padding: 15,
        borderRadius: 12,
        // A transparent border: forced colours draw it, so the notice keeps its edge there.
        borderWidth: 1,
        borderColor: "transparent",
        backgroundColor: amber ? colors.sand : colors.mint,
      }}
    >
      <Text
        style={[styles.small, { color: amber ? colors.gold : colors.teal }]}
      >
        {children}
      </Text>
    </View>
  );
}
export const webDir = (dir: TextDir | undefined) => (Platform.OS === "web" && dir ? { dir } : {});
export type TextDir = "auto" | "ltr" | "rtl";
const STRONG_RTL = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/;
const STRONG_LTR = /[A-Za-z\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff]/;
/**
 * The direction of a block of course text, from the first letter that has one (the demo course
 * declares no language). A container of course text takes it on web, so a measured paragraph and
 * a row of labels line up at the text's own start edge: English course text in a Hebrew interface
 * reads from the left like its heading, instead of hanging from the right. Undefined without a
 * letter; the browser then decides per paragraph.
 */
export function textDirection(...texts: (string | undefined)[]): TextDir | undefined {
  for (const text of texts)
    for (const character of text ?? "") {
      if (STRONG_RTL.test(character)) return "rtl";
      if (STRONG_LTR.test(character)) return "ltr";
    }
  return undefined;
}
/** A labelled text field (pass `dir="ltr"` for codes, numbers and URLs). Without `dir` it keeps the interface's direction, so an empty field's
 * placeholder and caret start at the reading edge (an empty `dir="auto"` field resolves to left to
 * right, which put a Hebrew placeholder on the left), and typed text shows in its own direction. */
export function Field({ label, dir, ...props }: TextInputProps & { label: string; dir?: TextDir }) {
  const [focused, setFocused] = useState(false);
  // react-native-web gives a TextInput dir="auto" unless told otherwise: name the interface's.
  const ui = useI18n().dir;
  return (
    <View style={{ gap: 8 }}>
      <Text style={[styles.small, { fontWeight: "600", color: colors.ink }]}>
        {label}
      </Text>
      <TextInput
        {...props}
        {...webDir(dir ?? ui)}
        accessibilityLabel={label}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholderTextColor={colors.muted}
        style={[
          {
            minHeight: props.multiline ? 112 : 48,
            borderRadius: 12,
            borderWidth: 2,
            // The field's edge keeps 3:1 (--line-strong); focus adds the accent border and the ring.
            borderColor: focused ? colors.teal : theme.lineStrong,
            backgroundColor: colors.white,
            color: colors.ink,
            fontSize: 16,
            lineHeight: 25,
            padding: 12,
            textAlignVertical: "top",
          },
          Platform.OS === "web" && !dir ? ({ unicodeBidi: "plaintext" } as object) : undefined,
          focused && focusRing,
          props.style,
        ]}
      />
    </View>
  );
}
export function ChoiceList({
  options,
  value,
  onChange,
  disabled,
  label,
  optionDir = "auto",
}: {
  options: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  label: string;
  /** Options are usually course text, in the course's language: they keep their own direction. */
  optionDir?: TextDir;
}) {
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={{ gap: 10 }}
    >
      {options.map((option, index) => (
        <Choice
          key={option.id}
          option={option}
          selected={value === option.id}
          disabled={disabled}
          dir={optionDir}
          onPress={() => onChange(option.id)}
          onArrow={(direction) =>
            onChange(
              options[(index + direction + options.length) % options.length]!
                .id,
            )
          }
        />
      ))}
    </View>
  );
}
function Choice({
  option,
  selected,
  onPress,
  onArrow,
  disabled,
  dir,
}: {
  option: { id: string; label: string };
  selected: boolean;
  onPress: () => void;
  onArrow: (direction: number) => void;
  disabled?: boolean;
  dir?: TextDir;
}) {
  const [focused, setFocused] = useState(false);
  // Right and left arrows follow the reading direction: in a right-to-left page, left is "next".
  const rtl = useI18n().dir === "rtl";
  const keyboardProps =
    Platform.OS === "web"
      ? {
          // A locked option keeps tabindex -1, which a tap or click would still focus: it would
          // show the focus border without being chosen. The press does nothing, so neither does focus.
          onMouseDown: (event: React.MouseEvent<HTMLElement>) => {
            if (disabled) event.preventDefault();
          },
          onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
            if (event.key === " ") {
              event.preventDefault();
              if (!disabled) onPress();
            }
            if (
              ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(
                event.key,
              )
            ) {
              event.preventDefault();
              const direction =
                event.key === "ArrowDown" ||
                event.key === (rtl ? "ArrowLeft" : "ArrowRight")
                  ? 1
                  : -1;
              if (!disabled) {
                onArrow(direction);
                const nodes =
                  event.currentTarget.parentElement?.querySelectorAll<HTMLElement>(
                    '[role="radio"]',
                  );
                if (nodes)
                  nodes[
                    (Array.from(nodes).indexOf(event.currentTarget) +
                      direction +
                      nodes.length) %
                      nodes.length
                  ]?.focus();
              }
            }
          },
        }
      : {};
  return (
    <LivePressable
      {...keyboardProps}
      accessibilityRole="radio"
      accessibilityLabel={option.label}
      accessibilityState={{ checked: selected, disabled }}
      aria-checked={selected}
      aria-disabled={!!disabled}
      disabled={disabled}
      onPress={onPress}
      onFocus={(event) => setFocused(showsFocus(event))}
      onBlur={() => setFocused(false)}
      style={[
        {
          flexDirection: "row",
          gap: 14,
          alignItems: "center",
          borderWidth: 2,
          borderColor: focused && !disabled && Platform.OS !== "web"
            ? colors.ink
            : selected
              ? colors.teal
              : theme.lineStrong,
          borderRadius: 14,
          padding: 16,
          minHeight: 58,
          backgroundColor: selected ? colors.mint : colors.white,
        },
        focused && !disabled && focusRing,
      ]}
    >
      <View
        importantForAccessibility="no"
        style={{
          height: 22,
          width: 22,
          borderRadius: 11,
          borderWidth: 2,
          borderColor: selected ? colors.teal : colors.muted,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {selected && (
          <View
            style={{
              width: 10,
              height: 10,
              borderRadius: 5,
              backgroundColor: colors.teal,
            }}
          />
        )}
      </View>
      <Text
        {...webDir(dir)}
        style={{ flex: 1, color: colors.ink, fontSize: 16, lineHeight: 24 }}
      >
        {option.label}
      </Text>
    </LivePressable>
  );
}
