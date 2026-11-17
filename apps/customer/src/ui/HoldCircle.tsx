/**
 * The circle of the home screen and its compact copy in C-12 (V2-UX option A «زر واحد», DEC-620 … DEC-624): one round
 * button that changes with the visit, and the app's one gesture to request the car — press and hold for 3 seconds.
 *
 * - **At rest** two soft rings breathe around it in its colour (blue, navy or green), a faint halo ring stays, and
 *   when the car is ready a green glow pulses (`glowPulse`).
 * - **Hold mode** (the car is parked): while the finger is down a bright arc fills a ring around the circle from
 *   twelve o'clock, clockwise, over `HOLD_MS` (3 s), with a light «comet» head travelling at its tip and a glow behind
 *   the circle that grows; the circle shrinks a little (pressed) and its content becomes the countdown 3 · 2 · 1 with
 *   a light haptic tick each second. Let go before the end → the ring unwinds quickly, nothing is requested and the
 *   parent shows the hint. At the end → a firm haptic tick, the ring stays full with the comet orbiting and the content
 *   says «جارٍ الإرسال…» until `onHoldComplete` settles (never twice: the state machine of `src/features/hold.ts`).
 * - **Tap mode** (every other state): a press shrinks it, a release on it calls `onPress`.
 * - **Changes of state** cross-fade: the old colour fades out over the new one, the content fades and scales in; and
 *   `burstKey` plays the light burst — a flash on the circle, a ring of light and a wave that expand from it — when the
 *   server accepted the request.
 *
 * Reduce motion (`holdMotion`): no rotating light, rings, glow, burst or press scale; the ring still fills linearly
 * while held, and everything else snaps.
 *
 * Built on React Native's responder system and `Animated` (transforms and opacity on the native driver; the ring's
 * `strokeDashoffset` on `react-native-svg` with the JS driver): touch on iOS and Android, mouse and touch on the web
 * export. Accessibility: one element, role «زر», named by the parent («اطلب السيارة» with the hint «اضغط مطولًا ثلاث
 * ثوانٍ، أو انقر مرتين للتأكيد»); a screen reader's activation and the keyboard's Enter or Space open the
 * confirmation dialog in hold mode (protection against a stray touch, DEC-622) and act as a tap otherwise. The
 * rings, glow and burst are decoration hidden from screen readers.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  Animated,
  Easing,
  Platform,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type GestureResponderEvent,
  type KeyDownEvent,
  type ViewStyle,
} from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import {
  HOLD_MS,
  holdMotion,
  holdProgress,
  holdReducer,
  initialHold,
  type HoldEvent,
  type HoldPhase,
  type HoldState,
} from '../features/hold';
import { color, radius, shadow, space } from '../theme/tokens';
import { haptic } from './haptics';
import { ease, nativeDriver, useReducedMotion } from './motion';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/** The web export only: no text selection, callout or page scroll while the circle is held. */
const WEB_HOLD: ViewStyle | null =
  Platform.OS === 'web'
    ? ({
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
        touchAction: 'none',
        cursor: 'pointer',
      } as unknown as ViewStyle)
    : null;

/** Decoration: never read, never touched. */
const HIDDEN = {
  'aria-hidden': true,
  accessibilityElementsHidden: true,
  importantForAccessibility: 'no-hide-descendants',
  pointerEvents: 'none',
} as const;

/** A finger that slides this far (in px) from where it went down has left the button: the hold is cancelled. */
const SLOP_SHARE = 0.6;

export interface HoldCircleState {
  phase: HoldPhase;
  count: number;
  hint: boolean;
}

export interface HoldCircleProps {
  /** the circle's diameter: 196 on the home screen, 76 in the C-12 sheet */
  size: number;
  /** the circle's colour (a semantic role: primary, surface-inverse, success) */
  tint: string;
  mode: 'hold' | 'tap';
  /** tap mode */
  onPress?: () => void;
  /** hold mode: the command; the circle shows «sending» until the returned promise settles */
  onHoldComplete?: () => Promise<unknown> | void;
  /** hold mode: the dialog of the screen reader and keyboard path */
  confirm?: { title: string; body: string; ok: string; cancel: string };
  accessibilityLabel: string;
  accessibilityHint?: string;
  testID?: string;
  /** what the circle shows at rest changes: its content cross-fades */
  contentKey: string;
  /** the content at rest (icon and label in white) */
  children: ReactNode;
  /** hold mode: the content while held (the countdown) */
  renderHolding?: (count: number) => ReactNode;
  /** hold mode: the content while the command runs */
  sending?: ReactNode;
  /** the hold's phase, countdown and hint, for a parent that writes them next to the circle */
  onHoldChange?: (s: HoldCircleState) => void;
  /** grows when the server accepted the request: the light burst plays */
  burstKey?: number;
  /** the colour of the burst's light (the brand blue by default: the light of the request, whatever comes next) */
  burstTint?: string;
  /** a green glow pulses (the car is ready) */
  glowPulse?: boolean;
  compact?: boolean;
  disabled?: boolean;
}

export function HoldCircle(props: HoldCircleProps) {
  const {
    size,
    tint,
    mode,
    accessibilityLabel,
    accessibilityHint,
    testID,
    contentKey,
    children,
    renderHolding,
    sending,
    burstKey = 0,
    burstTint = color.primary,
    glowPulse = false,
    compact = false,
    disabled = false,
  } = props;
  const reduced = useReducedMotion();
  const plan = holdMotion(reduced);

  // geometry: the ring runs just outside the circle; the box leaves room for the ring's glow and the comet's halo
  const pad = compact ? 16 : 30;
  const box = size + 2 * pad;
  const stroke = compact ? 4 : 6;
  const r = size / 2 + (compact ? 7 : 10);
  const circumference = 2 * Math.PI * r;
  const head = compact ? 10 : 14;

  const [state, setState] = useState<HoldState>(initialHold);
  const sm = useRef<HoldState>(initialHold);
  const latest = useRef(props);
  latest.current = props;
  const planRef = useRef(plan);
  planRef.current = plan;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // JS driver: the ring's dash; native driver: everything that is a transform or an opacity
  const progress = useRef(new Animated.Value(0)).current;
  const progressN = useRef(new Animated.Value(0)).current;
  const ringOn = useRef(new Animated.Value(0)).current;
  const orbit = useRef(new Animated.Value(0)).current;
  const press = useRef(new Animated.Value(1)).current;
  const pulse = useRef(new Animated.Value(0)).current;
  const burst = useRef(new Animated.Value(0)).current;
  const swap = useRef(new Animated.Value(1)).current;
  const tintFade = useRef(new Animated.Value(0)).current;

  const holdAnim = useRef<Animated.CompositeAnimation | null>(null);
  const orbitAnim = useRef<Animated.CompositeAnimation | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTimer = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };

  const pressTo = (value: number) => {
    if (planRef.current.pressScale === 1) {
      press.setValue(1);
      return;
    }
    (value === 1
      ? Animated.spring(press, { toValue: 1, speed: 18, bounciness: 8, useNativeDriver: nativeDriver })
      : Animated.timing(press, {
          toValue: value,
          duration: 160,
          easing: ease.standard,
          useNativeDriver: nativeDriver,
        })
    ).start();
  };

  const unwind = (from: number) => {
    holdAnim.current?.stop();
    orbitAnim.current?.stop();
    orbit.setValue(0);
    const ms = planRef.current.unwindMs(from);
    pressTo(1);
    if (ms === 0) {
      progress.setValue(0);
      progressN.setValue(0);
      ringOn.setValue(0);
      return;
    }
    const to0 = (v: Animated.Value, native: boolean) =>
      Animated.timing(v, { toValue: 0, duration: ms, easing: ease.standard, useNativeDriver: native });
    Animated.parallel([
      to0(progress, false),
      to0(progressN, nativeDriver),
      to0(ringOn, nativeDriver),
    ]).start();
  };

  const startHold = () => {
    holdAnim.current?.stop();
    progress.setValue(0);
    progressN.setValue(0);
    ringOn.setValue(1);
    const fill = (v: Animated.Value, native: boolean) =>
      Animated.timing(v, { toValue: 1, duration: HOLD_MS, easing: Easing.linear, useNativeDriver: native });
    holdAnim.current = Animated.parallel([fill(progress, false), fill(progressN, nativeDriver)]);
    holdAnim.current.start();
    pressTo(planRef.current.pressScale);
    haptic.tick();
    stopTimer();
    timer.current = setInterval(() => send({ type: 'tick', at: Date.now() }), 50);
  };

  const fire = () => {
    stopTimer();
    holdAnim.current?.stop();
    progress.setValue(1);
    progressN.setValue(1);
    ringOn.setValue(1);
    haptic.confirm();
    if (planRef.current.comet) {
      orbit.setValue(0);
      orbitAnim.current = Animated.loop(
        Animated.timing(orbit, {
          toValue: 1,
          duration: 1100,
          easing: Easing.linear,
          useNativeDriver: nativeDriver,
        }),
      );
      orbitAnim.current.start();
    }
    Promise.resolve()
      .then(() => latest.current.onHoldComplete?.())
      .catch(() => undefined)
      .finally(() => {
        if (mounted.current) send({ type: 'settled' });
      });
  };

  const settle = () => {
    orbitAnim.current?.stop();
    pressTo(1);
    const ms = planRef.current.swapMs;
    if (ms === 0) {
      orbit.setValue(0);
      ringOn.setValue(0);
      progress.setValue(0);
      progressN.setValue(0);
      return;
    }
    // the full ring fades out where it is (it does not unwind: the command is done, whatever its answer)
    Animated.timing(ringOn, {
      toValue: 0,
      duration: ms,
      easing: ease.standard,
      useNativeDriver: nativeDriver,
    }).start(() => {
      if (sm.current.phase !== 'idle') return;
      orbit.setValue(0);
      progress.setValue(0);
      progressN.setValue(0);
    });
  };

  /** One event through the state machine, and the side effects of the transition it made. */
  function send(e: HoldEvent): HoldState {
    const prev = sm.current;
    const next = holdReducer(prev, e);
    if (next === prev) return prev;
    sm.current = next;
    if (mounted.current) setState(next);
    if (prev.phase !== 'holding' && next.phase === 'holding') startHold();
    else if (prev.phase === 'holding' && next.phase === 'holding' && next.count < prev.count) haptic.tick();
    if (prev.phase === 'holding' && next.phase === 'idle') {
      stopTimer();
      unwind(holdProgress(prev, Date.now()));
    }
    if (next.fired > prev.fired) fire();
    if (prev.phase === 'sending' && next.phase === 'idle') settle();
    return next;
  }

  useEffect(
    () => () => {
      stopTimer();
      holdAnim.current?.stop();
      orbitAnim.current?.stop();
    },
    [],
  );

  // the visit moved on while the circle was held (a socket update): the hold is cancelled
  useEffect(() => {
    if ((mode !== 'hold' || disabled) && sm.current.phase === 'holding') send({ type: 'cancel' });
  }, [mode, disabled]);

  // the hint goes by itself after a few seconds
  useEffect(() => {
    if (!state.hint) return;
    const t = setTimeout(() => send({ type: 'hideHint' }), 4000);
    return () => clearTimeout(t);
  }, [state.hint]);

  useEffect(() => {
    latest.current.onHoldChange?.({ phase: state.phase, count: state.count, hint: state.hint });
  }, [state.phase, state.count, state.hint]);

  // the breathing rings (and the ready glow) at rest
  const breathing = plan.pulses && state.phase === 'idle';
  useEffect(() => {
    if (!breathing) {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(pulse, {
        toValue: 1,
        duration: 2400,
        easing: Easing.out(Easing.quad),
        useNativeDriver: nativeDriver,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [breathing, pulse]);

  // the old colour fades out over the new one
  const [prevTint, setPrevTint] = useState<string | null>(null);
  const lastTint = useRef(tint);
  useEffect(() => {
    if (lastTint.current === tint) return;
    const old = lastTint.current;
    lastTint.current = tint;
    if (plan.swapMs === 0) {
      setPrevTint(null);
      return;
    }
    setPrevTint(old);
    tintFade.setValue(1);
    Animated.timing(tintFade, {
      toValue: 0,
      duration: plan.swapMs,
      easing: ease.standard,
      useNativeDriver: nativeDriver,
    }).start(({ finished }) => {
      if (finished && mounted.current) setPrevTint(null);
    });
  }, [tint, plan.swapMs, tintFade]);

  // the content cross-fades (a new state, or held / sending / at rest)
  const swapKey =
    state.phase === 'holding' && renderHolding
      ? 'holding'
      : state.phase === 'sending' && sending
        ? 'sending'
        : contentKey;
  const lastSwap = useRef(swapKey);
  useEffect(() => {
    if (lastSwap.current === swapKey) return;
    lastSwap.current = swapKey;
    if (plan.swapMs === 0) {
      swap.setValue(1);
      return;
    }
    swap.setValue(0);
    Animated.timing(swap, {
      toValue: 1,
      duration: Math.round(plan.swapMs * 0.75),
      easing: ease.emphasized,
      useNativeDriver: nativeDriver,
    }).start();
  }, [swapKey, plan.swapMs, swap]);

  // the light burst when the request was accepted
  const lastBurst = useRef(burstKey);
  useEffect(() => {
    if (lastBurst.current === burstKey) return;
    lastBurst.current = burstKey;
    if (!plan.burst) return;
    burst.setValue(0);
    Animated.timing(burst, {
      toValue: 1,
      duration: 900,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: nativeDriver,
    }).start(() => burst.setValue(0));
  }, [burstKey, plan.burst, burst]);

  // touch: the gesture keeps the mode it started in — a hold that requested the car is not a tap on the circle the
  // request turned it into, however long the finger stays down afterwards
  const origin = useRef<{ x: number; y: number; moved: boolean; mode: 'hold' | 'tap' } | null>(null);
  const onGrant = (e: GestureResponderEvent) => {
    origin.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY, moved: false, mode };
    if (mode === 'hold') send({ type: 'press', at: Date.now() });
    else pressTo(plan.pressScale === 1 ? 1 : 0.96);
  };
  const onMove = (e: GestureResponderEvent) => {
    const o = origin.current;
    if (!o || o.moved) return;
    const far = Math.hypot(e.nativeEvent.pageX - o.x, e.nativeEvent.pageY - o.y) > size * SLOP_SHARE;
    if (!far) return;
    o.moved = true;
    if (o.mode === 'hold') send({ type: 'cancel' });
    else pressTo(1);
  };
  const onRelease = () => {
    const o = origin.current;
    origin.current = null;
    if (!o) return;
    if (o.mode === 'hold') {
      send({ type: 'release', at: Date.now() });
      return;
    }
    pressTo(1);
    if (!o.moved && !disabled && latest.current.mode === 'tap') {
      haptic.tap();
      latest.current.onPress?.();
    }
  };
  const onTerminate = () => {
    const o = origin.current;
    origin.current = null;
    if (o?.mode === 'hold') send({ type: 'cancel' });
    else pressTo(1);
  };

  // the screen reader's and the keyboard's path
  const activate = () => {
    if (disabled) return;
    if (mode === 'tap') {
      latest.current.onPress?.();
      return;
    }
    const c = latest.current.confirm;
    if (sm.current.phase !== 'idle' || !c) return;
    Alert.alert(c.title, c.body, [
      { text: c.cancel, style: 'cancel' },
      { text: c.ok, onPress: () => send({ type: 'confirm' }) },
    ]);
  };

  const holding = state.phase === 'holding';
  const busy = state.phase === 'sending';
  const content =
    holding && renderHolding ? renderHolding(state.count) : busy && sending ? sending : children;

  const ringBox = { width: box, height: box };
  const center = box / 2;
  const disc = { width: size, height: size, borderRadius: radius.full };
  const discAt = { position: 'absolute' as const, left: pad, top: pad, ...disc };

  const comet = Animated.add(progressN, orbit).interpolate({
    inputRange: [0, 2],
    outputRange: ['0deg', '720deg'],
  });
  const ringA = pulse.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });
  const ringB = Animated.modulo(Animated.add(pulse, 0.5), 1);
  const breath = (v: Animated.AnimatedInterpolation<number>) => ({
    opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] }),
    transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [1.02, 1.3] }) }],
  });

  return (
    <View style={[styles.box, ringBox]}>
      {/* the halo ring that stays (the mockup's soft ring) */}
      <View
        {...HIDDEN}
        style={[
          styles.layer,
          {
            left: pad / 2,
            top: pad / 2,
            width: size + pad,
            height: size + pad,
            borderRadius: radius.full,
            borderWidth: compact ? 1 : 2,
            borderColor: tint,
            opacity: 0.16,
          },
        ]}
      />
      {breathing ? (
        <>
          <Animated.View {...HIDDEN} style={[discAt, styles.ring, { borderColor: tint }, breath(ringA)]} />
          <Animated.View {...HIDDEN} style={[discAt, styles.ring, { borderColor: tint }, breath(ringB)]} />
          {glowPulse ? (
            <Animated.View
              {...HIDDEN}
              style={[
                discAt,
                {
                  backgroundColor: tint,
                  opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.32, 0] }),
                  transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.32] }) }],
                },
              ]}
            />
          ) : null}
        </>
      ) : null}
      {plan.glow ? (
        // the glow that grows while held
        <Animated.View
          {...HIDDEN}
          style={[
            discAt,
            {
              backgroundColor: tint,
              opacity: Animated.multiply(
                ringOn,
                progressN.interpolate({ inputRange: [0, 1], outputRange: [0, 0.34] }),
              ),
              transform: [{ scale: progressN.interpolate({ inputRange: [0, 1], outputRange: [1, 1.24] }) }],
            },
          ]}
        />
      ) : null}
      {plan.burst ? (
        <>
          {/* the wave of light and the ring of light of the burst */}
          <Animated.View
            {...HIDDEN}
            style={[
              discAt,
              {
                backgroundColor: burstTint,
                opacity: burst.interpolate({ inputRange: [0, 0.08, 1], outputRange: [0, 0.5, 0] }),
                transform: [{ scale: burst.interpolate({ inputRange: [0, 1], outputRange: [1, 1.55] }) }],
              },
            ]}
          />
          <Animated.View
            {...HIDDEN}
            style={[
              discAt,
              styles.burstRing,
              {
                borderColor: burstTint,
                opacity: burst.interpolate({ inputRange: [0, 0.05, 1], outputRange: [0, 1, 0] }),
                transform: [{ scale: burst.interpolate({ inputRange: [0, 1], outputRange: [1, 1.42] }) }],
              },
            ]}
          />
        </>
      ) : null}
      {mode === 'hold' || busy ? (
        // the progress ring: a faint track always, the bright arc and its glow while held and sending
        <View {...HIDDEN} style={[styles.layer, ringBox]}>
          <Svg width={box} height={box}>
            <Circle
              cx={center}
              cy={center}
              r={r}
              stroke={tint}
              strokeOpacity={0.14}
              strokeWidth={stroke}
              fill="none"
            />
          </Svg>
        </View>
      ) : null}
      <Animated.View {...HIDDEN} style={[styles.layer, ringBox, { opacity: ringOn }]}>
        <Svg width={box} height={box}>
          <AnimatedCircle
            cx={center}
            cy={center}
            r={r}
            stroke={tint}
            strokeOpacity={0.22}
            strokeWidth={stroke * 3}
            strokeLinecap="round"
            fill="none"
            strokeDasharray={`${circumference} ${circumference}`}
            strokeDashoffset={progress.interpolate({ inputRange: [0, 1], outputRange: [circumference, 0] })}
            transform={`rotate(-90 ${center} ${center})`}
          />
          <AnimatedCircle
            cx={center}
            cy={center}
            r={r}
            stroke={tint}
            strokeWidth={stroke}
            strokeLinecap="round"
            fill="none"
            strokeDasharray={`${circumference} ${circumference}`}
            strokeDashoffset={progress.interpolate({ inputRange: [0, 1], outputRange: [circumference, 0] })}
            transform={`rotate(-90 ${center} ${center})`}
          />
        </Svg>
      </Animated.View>
      {plan.comet ? (
        // the comet: a white light with a halo in the circle's colour at the arc's tip, turning with it
        <Animated.View
          {...HIDDEN}
          style={[styles.layer, ringBox, { opacity: ringOn, transform: [{ rotate: comet }] }]}
        >
          <View
            style={[
              styles.layer,
              {
                left: center - head,
                top: center - r - head,
                width: head * 2,
                height: head * 2,
                borderRadius: radius.full,
                backgroundColor: tint,
                opacity: 0.3,
              },
            ]}
          />
          <View
            style={[
              styles.layer,
              styles.head,
              {
                left: center - head / 2,
                top: center - r - head / 2,
                width: head,
                height: head,
                borderColor: tint,
              },
            ]}
          />
        </Animated.View>
      ) : null}

      {/* the circle itself: the one element screen readers and the keyboard meet */}
      <Animated.View
        testID={testID}
        accessible
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ disabled, busy }}
        aria-busy={busy}
        aria-disabled={disabled}
        accessibilityActions={[{ name: 'activate', label: accessibilityLabel }]}
        onAccessibilityAction={(e: AccessibilityActionEvent) => {
          if (e.nativeEvent.actionName === 'activate') activate();
        }}
        focusable={!disabled}
        onKeyDown={(e: KeyDownEvent) => {
          const key = e.nativeEvent.key;
          if (key === 'Enter' || key === ' ') {
            e.preventDefault();
            activate();
          }
        }}
        onStartShouldSetResponder={() => !disabled}
        onMoveShouldSetResponder={() => false}
        // a scroll view never takes a hold away half way (a tap may give way to a scroll)
        onResponderTerminationRequest={() => latest.current.mode !== 'hold'}
        onResponderGrant={onGrant}
        onResponderMove={onMove}
        onResponderRelease={onRelease}
        onResponderTerminate={onTerminate}
        {...(Platform.OS === 'web'
          ? { onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault() }
          : {})}
        style={[
          discAt,
          styles.disc,
          { backgroundColor: tint, boxShadow: compact ? shadow.md : shadow.lg },
          WEB_HOLD,
          {
            transform: [
              {
                scale: Animated.multiply(
                  press,
                  burst.interpolate({ inputRange: [0, 0.2, 1], outputRange: [1, 1.06, 1] }),
                ),
              },
            ],
          },
        ]}
      >
        {prevTint ? (
          <Animated.View
            {...HIDDEN}
            style={[StyleSheet.absoluteFill, disc, { backgroundColor: prevTint, opacity: tintFade }]}
          />
        ) : null}
        {plan.burst ? (
          <Animated.View
            {...HIDDEN}
            style={[
              StyleSheet.absoluteFill,
              disc,
              {
                backgroundColor: color.onPrimary,
                opacity: burst.interpolate({ inputRange: [0, 0.12, 1], outputRange: [0, 0.5, 0] }),
              },
            ]}
          />
        ) : null}
        <Animated.View
          pointerEvents="none"
          style={[
            styles.content,
            {
              opacity: swap,
              transform: [{ scale: swap.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1] }) }],
            },
          ]}
        >
          {content}
        </Animated.View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignSelf: 'center' },
  layer: { position: 'absolute', left: 0, top: 0 },
  ring: { borderWidth: 2, backgroundColor: 'transparent' },
  burstRing: { borderWidth: 4, backgroundColor: 'transparent' },
  head: { borderRadius: radius.full, backgroundColor: color.onPrimary, borderWidth: 3 },
  disc: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  content: { alignItems: 'center', justifyContent: 'center', gap: space[1], paddingHorizontal: space[3] },
});
