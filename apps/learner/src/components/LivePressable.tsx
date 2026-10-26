import React, { useLayoutEffect, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";

/** Web-only DOM props a learner control passes through (react-native-web forwards them). */
interface WebOnlyProps {
  onMouseDown?: (event: React.MouseEvent<HTMLElement>) => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLElement>) => void;
  dataSet?: Record<string, string>;
  "aria-checked"?: boolean;
  "aria-disabled"?: boolean;
  "aria-pressed"?: boolean;
  "aria-describedby"?: string;
}
export type LivePressableProps = Omit<PressableProps, "onPress" | "style" | "children" | "onKeyDown"> &
  WebOnlyProps & {
    onPress: () => void;
    style?: StyleProp<ViewStyle> | ((state: { pressed: boolean }) => StyleProp<ViewStyle>);
    children?: React.ReactNode;
  };

/**
 * A learner control that takes every press the page shows it ready for.
 *
 * react-native-web's Pressable gives its press responder a new `disabled` and `onPress` only in a
 * passive effect, after the render that changed them is on screen. A render from async work (a
 * request settling) commits, React yields for the paint, and its effects run in a later turn; on
 * a busy phone that is a frame or more. A tap in between reaches the previous `disabled` and the
 * previous handler: a button the page shows enabled ignores it, or an option runs the handler of
 * the render before.
 *
 * On web this control is a View with DOM event handlers, which React commits together with the
 * DOM, so what the learner sees enabled is what the press finds enabled. The handlers also read
 * the latest committed `disabled` and `onPress` (updated in a layout effect, inside the commit),
 * never a copy from an earlier render. Native apps keep Pressable.
 */
export function LivePressable(props: LivePressableProps) {
  return Platform.OS === "web" ? <WebPressable {...props} /> : <NativePressable {...props} />;
}

function NativePressable({ onMouseDown: _mouse, onKeyDown: _key, dataSet: _data, ...props }: LivePressableProps) {
  return <Pressable {...props} />;
}

function WebPressable({
  disabled,
  onPress,
  onFocus,
  onBlur,
  onHoverIn,
  onHoverOut,
  onKeyDown,
  style,
  children,
  accessibilityRole,
  tabIndex,
  ...rest
}: LivePressableProps) {
  const [pressed, setPressed] = useState(false);
  const live = useRef({ disabled: Boolean(disabled), onPress });
  useLayoutEffect(() => {
    live.current = { disabled: Boolean(disabled), onPress };
  });
  // react-native-web renders the button role as a <button>: the browser itself turns Enter and
  // Space on it into a click. Other roles (radio, checkbox) take Enter here, as Pressable did.
  const nativeButton = accessibilityRole === "button";
  const press = () => {
    if (!live.current.disabled) live.current.onPress();
  };
  const own = (event: { target: unknown; currentTarget: unknown }) => event.target === event.currentTarget;
  const hoverPointer = (event: unknown) =>
    (event as React.PointerEvent).pointerType !== "touch";
  const web = {
    ...rest,
    accessibilityRole,
    "aria-disabled": Boolean(disabled),
    tabIndex: tabIndex ?? (disabled ? -1 : 0),
    onClick: (event: React.MouseEvent<HTMLElement>) => {
      // As Pressable: a press is this control's, not a pressable ancestor's.
      if (!live.current.disabled || nativeButton) event.stopPropagation();
      if ((event as { altKey?: boolean }).altKey) return;
      press();
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      onKeyDown?.(event);
      if (event.defaultPrevented || nativeButton || event.key !== "Enter" || !own(event)) return;
      event.stopPropagation();
      press();
    },
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      if (event.button === 0 && !live.current.disabled) setPressed(true);
    },
    onPointerUp: () => setPressed(false),
    onPointerCancel: () => setPressed(false),
    onPointerLeave: (event: React.PointerEvent<HTMLElement>) => {
      setPressed(false);
      if (hoverPointer(event)) onHoverOut?.(event as never);
    },
    onPointerEnter: (event: React.PointerEvent<HTMLElement>) => {
      if (hoverPointer(event)) onHoverIn?.(event as never);
    },
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      if (own(event)) onFocus?.(event as never);
    },
    onBlur: (event: React.FocusEvent<HTMLElement>) => {
      if (own(event)) onBlur?.(event as never);
    },
    style: [disabled ? webStyles.disabled : webStyles.active, typeof style === "function" ? style({ pressed }) : style],
  };
  return React.createElement(View, web as unknown as React.ComponentProps<typeof View>, children);
}

// Pressable's own web styles: a pointer and no double-tap zoom delay while enabled; a disabled
// control lets pointer events through to what is under it, as before.
const webStyles = StyleSheet.create({
  active: { cursor: "pointer", touchAction: "manipulation" } as ViewStyle,
  disabled: { pointerEvents: "box-none" },
});
