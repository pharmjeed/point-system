/**
 * Page frame (03 §2.4 `AppShell` for the phone): safe areas, scrolling with the keyboard, 16px padding, content at
 * most 480 wide, and an optional footer that keeps the main action within reach of the thumb. V2-UX (DEC-571): the
 * footer is a sticky bottom sheet — a raised surface with rounded top corners holding the one primary action of the
 * state — and the content fades in when the screen opens (none under reduce motion).
 */
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, layout, radius, shadow, space } from '../theme/tokens';
import { FadeIn } from './Animated';

export function Screen({
  children,
  footer,
  footerKey,
}: {
  children: ReactNode;
  footer?: ReactNode;
  /** replays the footer's entrance when its action changes (C-12: request → code → pay) */
  footerKey?: string | null;
}) {
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <FadeIn style={styles.content}>{children}</FadeIn>
        </ScrollView>
        {footer ? (
          <View style={styles.footerSheet}>
            <FadeIn swapKey={footerKey ?? null} style={styles.footer}>
              {footer}
            </FadeIn>
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.bg },
  flex: { flex: 1 },
  scroll: { flexGrow: 1, padding: space[4], paddingBottom: space[6], alignItems: 'center' },
  content: { width: '100%', maxWidth: layout.shellMaxW, gap: space[3] },
  footerSheet: {
    backgroundColor: color.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: 1,
    borderColor: color.border,
    boxShadow: shadow.lg,
  },
  footer: {
    width: '100%',
    maxWidth: layout.shellMaxW,
    alignSelf: 'center',
    paddingHorizontal: space[4],
    paddingTop: space[4],
    paddingBottom: space[3],
    gap: space[2],
  },
});
