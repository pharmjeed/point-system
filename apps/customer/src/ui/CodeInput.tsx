/**
 * Six-digit sign-in code (C-03, C-20), after `CodeInput` of 03 §3.11: IBM Plex Mono 600 / 24px boxes, numeric keypad,
 * paste supported, left to right. One hidden field holds the value; the boxes only show it. No automatic submit.
 * V2-UX (DEC-576): the boxes share the width (up to 56 each), a filled box turns blue, the next box shows a blinking
 * caret (the auto-advance look) and each digit pops in; still under reduce motion.
 */
import { useEffect, useRef, type ComponentRef } from 'react';
import { Animated, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { CUSTOMER_OTP_LENGTH } from '@point/shared/customer';
import { color, font, fontSize, radius, space } from '../theme/tokens';
import { AppText } from './AppText';
import { ease, motion, nativeDriver, useReducedMotion } from './motion';

function Cell({
  digit,
  active,
  invalid,
  disabled,
}: {
  digit: string;
  active: boolean;
  invalid?: boolean;
  disabled?: boolean;
}) {
  const reduced = useReducedMotion();
  const pop = useRef(new Animated.Value(1)).current;
  const caret = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (reduced || !digit) return;
    pop.setValue(0.8);
    Animated.timing(pop, {
      toValue: 1,
      duration: motion.base,
      easing: ease.emphasized,
      useNativeDriver: nativeDriver,
    }).start();
  }, [digit, pop, reduced]);
  useEffect(() => {
    if (reduced || !active) {
      caret.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(caret, { toValue: 0, duration: 500, useNativeDriver: nativeDriver }),
        Animated.timing(caret, { toValue: 1, duration: 500, useNativeDriver: nativeDriver }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, caret, reduced]);
  return (
    <View
      style={[
        styles.cell,
        digit !== '' && styles.cellFilled,
        active && styles.cellActive,
        invalid && styles.cellInvalid,
        disabled && styles.cellDisabled,
      ]}
    >
      {digit ? (
        <Animated.View style={{ transform: [{ scale: pop }] }}>
          <AppText style={styles.digit}>{digit}</AppText>
        </Animated.View>
      ) : active ? (
        <Animated.View style={[styles.caret, { opacity: caret }]} />
      ) : null}
    </View>
  );
}

export function CodeInput({
  value,
  onChange,
  label,
  disabled,
  invalid,
}: {
  value: string;
  onChange: (next: string) => void;
  label: string;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const cells = Array.from({ length: CUSTOMER_OTP_LENGTH }, (_, i) => value[i] ?? '');
  return (
    <Pressable onPress={() => input.current?.focus()} accessible={false}>
      <View style={styles.row}>
        {cells.map((digit, i) => (
          <Cell
            key={i}
            digit={digit}
            active={i === value.length && !disabled}
            invalid={invalid}
            disabled={disabled}
          />
        ))}
      </View>
      <TextInput
        ref={input}
        value={value}
        onChangeText={onChange}
        editable={!disabled}
        autoFocus
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        maxLength={CUSTOMER_OTP_LENGTH + 4}
        accessibilityLabel={label}
        testID="code-input"
        style={styles.hidden}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', direction: 'ltr', gap: space[2], justifyContent: 'center' },
  cell: {
    flex: 1,
    maxWidth: 56,
    height: 64,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.borderStrong,
    backgroundColor: color.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellFilled: { borderColor: color.primary, backgroundColor: color.primarySubtle },
  cellActive: { borderColor: color.focus, borderWidth: 2 },
  cellInvalid: { borderColor: color.danger, backgroundColor: color.dangerSubtle },
  cellDisabled: { backgroundColor: color.surface2, borderColor: color.border },
  digit: { fontFamily: font.monoSemibold, ...fontSize['3xl'], color: color.text, textAlign: 'center' },
  caret: { width: 2, height: 28, borderRadius: 1, backgroundColor: color.focus },
  hidden: { position: 'absolute', opacity: 0, width: 1, height: 1 },
});
