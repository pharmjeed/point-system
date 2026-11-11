/**
 * `EmptyState` of 03 §3.14 for the customer app (V2-UX, DEC-575): an icon in a soft circle, the sentence of the
 * screen (unchanged copy), and at most one action.
 */
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { color, radius, shadow, space } from '../theme/tokens';
import { AppText } from './AppText';
import { IconBadge } from './Controls';
import type { IconName } from './Icon';

export function EmptyState({
  icon,
  text,
  action,
  compact,
}: {
  icon: IconName;
  text: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <View style={[styles.box, compact && styles.compact]}>
      <IconBadge name={icon} size={compact ? 44 : 64} />
      <AppText tone="muted" center>
        {text}
      </AppText>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    alignItems: 'center',
    gap: space[3],
    padding: space[6],
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.border,
    boxShadow: shadow.sm,
  },
  compact: { padding: space[4], gap: space[2] },
});
