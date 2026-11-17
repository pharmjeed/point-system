/**
 * Slide to confirm (V2-UX, DEC-583, DEC-584): the control that requests the car on C-06 and C-12, so a car is never
 * requested by a stray tap. A navy pill (the action colour of the live card) with a white knob holding the car; the
 * knob is dragged from the start edge to the end edge — right to left in Arabic, left to right in English — and a
 * release past 85 % confirms (`SWIPE_CONFIRM_AT`), anything shorter springs back (a snap under reduce motion). The
 * label fades as the knob moves. On confirm: a haptic tick, the knob stays at the end and the pill shows «جارٍ
 * الإرسال…» until `onConfirm` settles (the server's answer); then it goes back to rest — the screen has usually moved
 * on by then. It never fires twice: the drag, the keyboard and the screen reader are all ignored while it is busy.
 *
 * Built on React Native's `PanResponder` and `Animated` (no new dependency): the same code takes touch drags on
 * iOS and Android and mouse or touch drags in the web export (react-native-web's responder system).
 *
 * Accessibility: the knob is the one element screen readers meet — role «زر», named «اطلب السيارة», hint «اسحب أو
 * انقر مرتين للتأكيد» (the drawn label is hidden from them, it would say the same). A screen reader cannot drag
 * reliably, so its activation (`accessibilityActions` «activate», the double tap) opens the confirmation dialog the
 * swipe replaced for everybody else — still two deliberate steps. On the web export the knob takes the keyboard focus,
 * and Enter or Space opens the same dialog. Test ids: `{testID}` on the pill, `{testID}-knob` on the knob (the
 * element a test or Maestro drags, and the one iOS exposes inside the pill).
 */
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  PanResponder,
  Platform,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type KeyDownEvent,
  type LayoutChangeEvent,
  type ViewStyle,
} from 'react-native';
import {
  isHorizontalDrag,
  swipeOffset,
  swipeOutcome,
  swipeTravel,
  SWIPE_LABEL_FADE,
} from '../features/swipe';
import { color, font, fontSize, layout, radius, shadow, space } from '../theme/tokens';
import { AppText } from './AppText';
import { isRTL } from './direction';
import { haptic } from './haptics';
import { Icon } from './Icon';
import { ease, motion, nativeDriver, useReducedMotion } from './motion';

/** The pill is as tall as the main button (56), the knob a 48 target inside it (DEC-575). */
const TRACK_H = layout.buttonLg;
const INSET = space[1];
const KNOB = TRACK_H - 2 * INSET;

/** The web export only: no text selection or page scroll while the mouse or finger drags the knob. */
const WEB_DRAG: ViewStyle | null =
  Platform.OS === 'web' ? ({ userSelect: 'none', touchAction: 'pan-y' } as unknown as ViewStyle) : null;

export interface SwipeToConfirmProps {
  /** the visible instruction: «اسحب لطلب السيارة» */
  label: string;
  /** the name for screen readers: «اطلب السيارة» */
  accessibilityLabel: string;
  accessibilityHint: string;
  /** the dialog of the screen reader and keyboard path */
  confirm: { title: string; body: string; ok: string; cancel: string };
  /** shown while `onConfirm` runs: «جارٍ الإرسال…» */
  busyLabel: string;
  /** the command; the control stays busy until the returned promise settles */
  onConfirm: () => Promise<unknown> | void;
  disabled?: boolean;
  testID?: string;
  /** the drag started or ended: a scrolling parent can hold still meanwhile */
  onDragChange?: (dragging: boolean) => void;
}

export function SwipeToConfirm({
  label,
  accessibilityLabel,
  accessibilityHint,
  confirm,
  busyLabel,
  onConfirm,
  disabled = false,
  testID,
  onDragChange,
}: SwipeToConfirmProps) {
  const reduced = useReducedMotion();
  const rtl = isRTL();
  const offset = useRef(new Animated.Value(0)).current;
  const [travel, setTravel] = useState(0);
  const [busy, setBusy] = useState(false);

  // the responder below is created once: it reads the latest values through these
  const live = useRef({ travel, busy: false, disabled, rtl, reduced, onConfirm, onDragChange });
  live.current = { ...live.current, travel, disabled, rtl, reduced, onConfirm, onDragChange };
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const moveTo = (value: number, kind: 'spring' | 'finish') => {
    if (live.current.reduced) {
      offset.setValue(value);
      return;
    }
    (kind === 'spring'
      ? Animated.spring(offset, { toValue: value, speed: 20, bounciness: 6, useNativeDriver: nativeDriver })
      : Animated.timing(offset, {
          toValue: value,
          duration: motion.fast,
          easing: ease.standard,
          useNativeDriver: nativeDriver,
        })
    ).start();
  };

  const fire = () => {
    const now = live.current;
    if (now.busy || now.disabled) return;
    now.busy = true;
    setBusy(true);
    haptic.confirm();
    Promise.resolve()
      .then(() => now.onConfirm())
      .catch(() => undefined)
      .finally(() => {
        live.current.busy = false;
        if (!mounted.current) return;
        setBusy(false);
        moveTo(0, 'spring');
      });
  };

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !live.current.busy && !live.current.disabled,
      onMoveShouldSetPanResponder: (_, g) =>
        !live.current.busy && !live.current.disabled && isHorizontalDrag(g.dx, g.dy),
      // a scroll view around it never takes the drag away half way
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        offset.stopAnimation();
        live.current.onDragChange?.(true);
      },
      onPanResponderMove: (_, g) => {
        offset.setValue(swipeOffset(g.dx, live.current.travel, live.current.rtl));
      },
      onPanResponderRelease: (_, g) => {
        live.current.onDragChange?.(false);
        const { travel: max, rtl: r } = live.current;
        if (swipeOutcome(swipeOffset(g.dx, max, r), max) === 'confirm') {
          moveTo(max, 'finish');
          fire();
        } else moveTo(0, 'spring');
      },
      onPanResponderTerminate: () => {
        live.current.onDragChange?.(false);
        moveTo(0, 'spring');
      },
    }),
  ).current;

  // the screen reader's and the keyboard's path: the confirmation dialog, then the same command
  const ask = () => {
    if (live.current.busy || live.current.disabled) return;
    Alert.alert(confirm.title, confirm.body, [
      { text: confirm.cancel, style: 'cancel' },
      {
        text: confirm.ok,
        onPress: () => {
          moveTo(live.current.travel, 'finish');
          fire();
        },
      },
    ]);
  };

  const onLayout = (e: LayoutChangeEvent) => {
    const next = swipeTravel({ track: e.nativeEvent.layout.width, knob: KNOB, inset: INSET });
    setTravel(next);
    if (live.current.busy) offset.setValue(next);
  };

  const fadeEnd = Math.max(1, travel * SWIPE_LABEL_FADE);
  const labelOpacity = offset.interpolate({
    inputRange: [0, fadeEnd],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });
  const translateX = Animated.multiply(offset, rtl ? -1 : 1);

  // the label is drawn for the eye only: the knob carries the name, the hint and the actions for screen readers
  const hidden = {
    'aria-hidden': true,
    accessibilityElementsHidden: true,
    importantForAccessibility: 'no-hide-descendants',
  } as const;

  return (
    <View
      testID={testID}
      onLayout={onLayout}
      style={[styles.track, disabled && styles.trackDisabled, WEB_DRAG]}
    >
      <Animated.View
        {...hidden}
        pointerEvents="none"
        style={[styles.labelBox, { opacity: busy ? 0 : labelOpacity }]}
      >
        <AppText style={styles.label} numberOfLines={1}>
          {label}
        </AppText>
        <Icon name="go-swipe" size={20} tint={color.textOnInverseMuted} />
      </Animated.View>
      {busy ? (
        <View {...hidden} pointerEvents="none" style={styles.labelBox}>
          <AppText style={styles.label} numberOfLines={1}>
            {busyLabel}
          </AppText>
        </View>
      ) : null}
      <Animated.View
        {...pan.panHandlers}
        testID={testID ? `${testID}-knob` : undefined}
        accessible
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ disabled, busy }}
        aria-busy={busy}
        aria-disabled={disabled}
        accessibilityActions={[{ name: 'activate', label: accessibilityLabel }]}
        onAccessibilityAction={(e: AccessibilityActionEvent) => {
          if (e.nativeEvent.actionName === 'activate') ask();
        }}
        focusable={!disabled}
        onKeyDown={(e: KeyDownEvent) => {
          const key = e.nativeEvent.key;
          if (key === 'Enter' || key === ' ') {
            e.preventDefault();
            ask();
          }
        }}
        style={[styles.knob, { transform: [{ translateX }] }]}
      >
        {busy ? (
          <ActivityIndicator color={color.primary} />
        ) : (
          <Icon name="car" size={26} tint={disabled ? color.textDisabled : color.primary} />
        )}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: TRACK_H,
    borderRadius: radius.full,
    backgroundColor: color.surfaceInverse,
    padding: INSET,
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'stretch',
    overflow: 'hidden',
    boxShadow: shadow.md,
  },
  trackDisabled: { backgroundColor: color.surface2, boxShadow: 'none' },
  // centred on the whole pill, clear of the knob at rest on either side
  labelBox: {
    ...StyleSheet.absoluteFill,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[1],
    paddingHorizontal: KNOB + INSET,
  },
  label: { ...fontSize.base, fontFamily: font.bold, color: color.textOnInverse },
  knob: {
    width: KNOB,
    height: KNOB,
    borderRadius: radius.full,
    backgroundColor: color.surface,
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: shadow.md,
  },
});
