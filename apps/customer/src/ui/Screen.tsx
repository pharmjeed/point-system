/**
 * Page frame (03 §2.4 `AppShell` for the phone): safe areas, scrolling with the keyboard, 16px padding, content at
 * most 480 wide, and an optional footer that keeps the main action within reach of the thumb.
 */
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, layout, space } from '../theme/tokens';

export function Screen({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.content}>{children}</View>
        </ScrollView>
        {footer ? <View style={styles.footer}>{footer}</View> : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.bg },
  flex: { flex: 1 },
  scroll: { flexGrow: 1, padding: space[4], alignItems: 'center' },
  content: { width: '100%', maxWidth: layout.shellMaxW, gap: space[3] },
  footer: {
    width: '100%',
    maxWidth: layout.shellMaxW,
    alignSelf: 'center',
    paddingHorizontal: space[4],
    paddingVertical: space[3],
    gap: space[2],
    backgroundColor: color.bg,
  },
});
