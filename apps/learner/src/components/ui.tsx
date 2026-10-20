import React, { useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";

export const colors = {
  paper: "#F8F8F2",
  white: "#FFFFFF",
  ink: "#183237",
  muted: "#526A70",
  line: "#DCE6E2",
  teal: "#087B69",
  mint: "#E8F6ED",
  purple: "#7050A4",
  lilac: "#F2EDFB",
  gold: "#80601E",
  sand: "#FCF3DF",
  stage: "#19383E",
};
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
  eyebrow: {
    color: colors.teal,
    fontSize: 11,
    lineHeight: 18,
    fontWeight: "700",
    letterSpacing: 1.7,
    textTransform: "uppercase",
  },
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
}) {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      {...(Platform.OS === "web" && describedBy ? { "aria-describedby": describedBy } : {})}
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
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => [
        {
          ...buttonBox,
          backgroundColor:
            kind === "primary"
              ? colors.teal
              : kind === "quiet"
                ? "transparent"
                : colors.white,
          borderColor: focused
            ? colors.ink
            : kind === "primary"
              ? colors.teal
              : kind === "quiet"
                ? "transparent"
                : colors.line,
          opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
        },
        hovered &&
          !disabled &&
          kind !== "primary" && { backgroundColor: colors.mint },
        style,
      ]}
    >
      <Text
        style={[
          buttonLabel,
          { color: kind === "primary" ? colors.white : colors.teal },
        ]}
      >
        {label}
      </Text>
    </Pressable>
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
  const pair = {
    mint: [colors.mint, colors.teal],
    lilac: [colors.lilac, colors.purple],
    sand: [colors.sand, colors.gold],
    neutral: [colors.paper, colors.muted],
  }[tone];
  return (
    <View
      style={{
        backgroundColor: pair[0],
        borderRadius: 7,
        paddingHorizontal: 10,
        paddingVertical: badgePadding,
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
export function Notice({
  children,
  error = false,
}: {
  children: React.ReactNode;
  error?: boolean;
}) {
  return (
    <View
      accessibilityRole={error ? "alert" : undefined}
      accessibilityLiveRegion="polite"
      aria-live={error ? "assertive" : "polite"}
      style={{
        padding: 16,
        borderRadius: 12,
        backgroundColor: error ? colors.sand : colors.mint,
      }}
    >
      <Text
        style={[styles.small, { color: error ? colors.gold : colors.teal }]}
      >
        {children}
      </Text>
    </View>
  );
}
export function Field({ label, ...props }: TextInputProps & { label: string }) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ gap: 8 }}>
      <Text style={[styles.small, { fontWeight: "600", color: colors.ink }]}>
        {label}
      </Text>
      <TextInput
        {...props}
        accessibilityLabel={label}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholderTextColor={colors.muted}
        style={[
          {
            minHeight: props.multiline ? 112 : 48,
            borderRadius: 12,
            borderWidth: 2,
            borderColor: focused ? colors.teal : colors.line,
            backgroundColor: colors.white,
            color: colors.ink,
            fontSize: 16,
            lineHeight: 25,
            padding: 12,
            textAlignVertical: "top",
          },
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
}: {
  options: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  label: string;
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
}: {
  option: { id: string; label: string };
  selected: boolean;
  onPress: () => void;
  onArrow: (direction: number) => void;
  disabled?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const keyboardProps =
    Platform.OS === "web"
      ? {
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
              const direction = ["ArrowDown", "ArrowRight"].includes(event.key)
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
    <Pressable
      {...keyboardProps}
      accessibilityRole="radio"
      accessibilityLabel={option.label}
      accessibilityState={{ checked: selected, disabled }}
      aria-checked={selected}
      aria-disabled={!!disabled}
      disabled={disabled}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        flexDirection: "row",
        gap: 14,
        alignItems: "center",
        borderWidth: 2,
        borderColor: focused
          ? colors.ink
          : selected
            ? colors.teal
            : colors.line,
        borderRadius: 14,
        padding: 16,
        minHeight: 58,
        backgroundColor: selected ? colors.mint : colors.white,
      }}
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
        style={{ flex: 1, color: colors.ink, fontSize: 16, lineHeight: 24 }}
      >
        {option.label}
      </Text>
    </Pressable>
  );
}
