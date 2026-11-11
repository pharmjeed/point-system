/**
 * The pressed state of every tappable surface of the customer app (V2-UX, DEC-572): a quick scale-down (0.97) and a
 * tint while the finger is down (`--pt-duration-fast`, 120 ms), back on release; with reduce motion only the tint.
 * Optional haptic tick (haptics.ts). Same props as `Pressable` (role, label, hint, testID …).
 */
import { useRef, type ReactNode } from 'react';
import {
  Animated,
  Pressable,
  type GestureResponderEvent,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { haptic } from './haptics';
import { ease, motion, nativeDriver, useReducedMotion } from './motion';

export interface TouchableProps extends Omit<PressableProps, 'style' | 'children'> {
  children: ReactNode | ((state: { pressed: boolean }) => ReactNode);
  style?: StyleProp<ViewStyle> | ((state: { pressed: boolean }) => StyleProp<ViewStyle>);
  /** the outer box (layout: flex, width) when `style` draws the surface */
  containerStyle?: StyleProp<ViewStyle>;
  /** how far it shrinks while pressed (1 = not at all) */
  pressScale?: number;
  feedback?: 'tap' | 'select' | 'none';
}

export function Touchable({
  children,
  style,
  containerStyle,
  pressScale = 0.97,
  feedback = 'none',
  onPressIn,
  onPressOut,
  onPress,
  disabled,
  ...rest
}: TouchableProps) {
  const reduced = useReducedMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const to = (value: number) =>
    Animated.timing(scale, {
      toValue: value,
      duration: motion.fast,
      easing: ease.standard,
      useNativeDriver: nativeDriver,
    }).start();
  return (
    <Animated.View style={[containerStyle, !reduced && { transform: [{ scale }] }]}>
      <Pressable
        {...rest}
        disabled={disabled}
        onPressIn={(e: GestureResponderEvent) => {
          if (!reduced && pressScale !== 1) to(pressScale);
          onPressIn?.(e);
        }}
        onPressOut={(e: GestureResponderEvent) => {
          if (!reduced && pressScale !== 1) to(1);
          onPressOut?.(e);
        }}
        onPress={(e: GestureResponderEvent) => {
          if (feedback === 'tap') haptic.tap();
          else if (feedback === 'select') haptic.select();
          onPress?.(e);
        }}
        style={style}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}
