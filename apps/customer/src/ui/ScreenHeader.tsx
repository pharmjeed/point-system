/**
 * The title row of a sub-screen (C-07, C-08, C-15, C-19, C-20 …): a back action on the reading side and the screen
 * title as the header (03 §5: one header per screen, back reachable with a 48 target). V2-UX (DEC-573): the back
 * action is a round surface button with the Lucide arrow, mirrored in RTL so it points to the start of the line
 * (DEC-85) on iOS, Android and the web export alike; an optional `subtitle` (the venue of C-12) and `action` (an
 * icon button at the end). The root screens of the tab bar (C-14, C-16, C-19; DEC-582) show the title alone.
 */
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { color, radius, shadow, space } from '../theme/tokens';
import { AppText } from './AppText';
import { Icon, type IconName } from './Icon';
import { Touchable } from './Touchable';

export function IconButton({
  icon,
  label,
  onPress,
  testID,
  tone = 'surface',
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  testID?: string;
  tone?: 'surface' | 'plain';
}) {
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={4}
      testID={testID}
      pressScale={0.92}
      style={({ pressed }) => [
        styles.iconButton,
        tone === 'surface' && styles.iconSurface,
        pressed && { backgroundColor: color.primarySubtle },
      ]}
    >
      <Icon name={icon} size={22} tint={color.text} />
    </Touchable>
  );
}

export function ScreenHeader({
  title,
  backLabel,
  onBack,
  subtitle,
  action,
}: {
  title: string;
  /** both or neither: the root screens of the tab bar (V2-UX option B, DEC-582) have no back action */
  backLabel?: string;
  onBack?: () => void;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <View style={styles.row}>
      {onBack && backLabel ? <IconButton icon="back" label={backLabel} onPress={onBack} /> : null}
      <View style={styles.titles}>
        <AppText variant="title" accessibilityRole="header" numberOfLines={2}>
          {title}
        </AppText>
        {subtitle ? (
          <AppText variant="small" tone="muted" numberOfLines={1}>
            {subtitle}
          </AppText>
        ) : null}
      </View>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space[3], marginBottom: space[1] },
  iconButton: {
    width: space[12],
    height: space[12],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
  },
  iconSurface: {
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    boxShadow: shadow.sm,
  },
  titles: { flex: 1, gap: space[0.5] },
});
