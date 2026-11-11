/**
 * `Sheet` of 03 §3.14 for the customer app (V2-UX, DEC-579): a bottom sheet over the dimmed screen — the brand navy
 * at 45 % behind, a raised surface with 24 px top corners (`radius.xl`) and a grab handle, sliding up (the platform's
 * modal slide, 320 ms class; none under the system's reduce motion). The pay sheet (C-10) and the rating (C-13) use
 * it; their content scrolls inside.
 */
import type { ReactNode } from 'react';
import { Modal, StyleSheet, View } from 'react-native';
import { color, layout, radius, shadow, space } from '../theme/tokens';

export function Sheet({
  visible,
  onRequestClose,
  children,
}: {
  visible: boolean;
  onRequestClose: () => void;
  children: ReactNode;
}) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      statusBarTranslucent
      onRequestClose={onRequestClose}
    >
      <View style={styles.backdrop}>
        <View style={styles.scrim} />
        <View style={styles.sheet} accessibilityViewIsModal>
          <View style={styles.handle} />
          {children}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  // the screen behind, dimmed with the navy of the brand
  scrim: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: color.surfaceInverse,
    opacity: 0.45,
  },
  sheet: {
    maxHeight: '94%',
    width: '100%',
    maxWidth: layout.shellMaxW + space[8],
    alignSelf: 'center',
    backgroundColor: color.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    boxShadow: shadow.lg,
    paddingTop: space[2],
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: radius.full,
    backgroundColor: color.border,
    marginBottom: space[2],
  },
});
