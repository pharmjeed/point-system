/**
 * `StatusChip` of 03 §3.3 for the customer app (V2-UX): the ticket status as text + icon + the status colours of
 * brand §4.3 (`status.*`), never colour alone. The icons are the design system's (`Point.TICKET_STATUS`, DEC-49).
 * `live` adds the breathing dot of a visit in progress (C-06).
 */
import type { TicketStatus } from '@point/shared';
import { StyleSheet, View } from 'react-native';
import { font, fontSize, radius, space, statusColor } from '../theme/tokens';
import { Pulse } from './Animated';
import { AppText } from './AppText';
import { Icon, type IconName } from './Icon';

export const STATUS_ICON: Readonly<Record<TicketStatus, IconName>> = {
  received: 'car-front',
  parking: 'circle-parking',
  parked: 'square-parking',
  requested: 'bell-ring',
  assigned: 'user-check',
  assigned_waiting: 'bookmark',
  retrieving: 'navigation',
  ready: 'circle-check',
  delivered: 'check-check',
  reparking: 'rotate-ccw',
  voided: 'circle-x',
};

export function StatusChip({ status, label, live }: { status: TicketStatus; label: string; live?: boolean }) {
  const c = statusColor[status];
  return (
    <View style={[styles.chip, { backgroundColor: c.bg }]}>
      {live ? (
        <Pulse size={10} tint={c.fg}>
          <View style={[styles.dot, { backgroundColor: c.fg }]} />
        </Pulse>
      ) : null}
      <Icon name={STATUS_ICON[status]} size={16} tint={c.fg} />
      <AppText style={[styles.text, { color: c.fg }]} numberOfLines={1}>
        {label}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: space[1] + space[0.5],
    paddingHorizontal: space[3],
    paddingVertical: space[1],
    borderRadius: radius.full,
  },
  dot: { width: 8, height: 8, borderRadius: radius.full },
  text: { ...fontSize.sm, fontFamily: font.semibold },
});
