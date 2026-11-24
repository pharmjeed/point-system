/**
 * The pickers of C-05's second step (owner's option 3, DEC-638):
 *
 * - `TypeTiles`: the five vehicle types as tiles, each a side-view outline and its name.
 * - `ColorSwatches`: the paints as round swatches with their name under each; the common nine first and «المزيد»
 *   for the rest and «أخرى».
 * - `MakePicker`: one field showing the chosen make; it opens a sheet listing the makes of 02 §8.4.
 *
 * Each is a radio group for screen readers (role radio, selected state, the name as label). The choice is shown by
 * a 2 px primary border and a tick or a tinted tile, never by colour alone; a second tap on the chosen one clears it
 * (the fields are optional).
 */
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import type { CustomerVehicleType } from '@point/shared/customer';
import { VEHICLE_COLOR_SWATCH, VEHICLE_COLORS_FIRST } from '../features/vehicle';
import { color, radius, space } from '../theme/tokens';
import { AppText } from './AppText';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import { Touchable } from './Touchable';

/** Side-view outlines (viewBox 52 × 26), drawn for C-05; wheels are added for every type but «other». */
const TYPE_OUTLINE: Record<CustomerVehicleType, string> = {
  sedan: 'M3 19v-3.5c0-1.2.8-2 2-2.3l8-1.7 6-6h13l8 6 7 1.4c1.2.3 2 1.2 2 2.4V19M20 11.5h21',
  suv: 'M3 19v-6c0-1.2.8-2 2-2h5l4-6h21l7 6h4c1.2 0 2 .8 2 2v6M26 5v6',
  pickup: 'M3 19v-6c0-1.2.8-2 2-2h22V5h-9l-4 6M27 11h20c1.2 0 2 .8 2 2v6',
  van: 'M3 19V7c0-1.2.8-2 2-2h30l10 7c.8.5 1.2 1.2 1.2 2V19M35 5v7h11',
  other: '',
};

function TypeIcon({ type, tint }: { type: CustomerVehicleType; tint: string }) {
  return (
    <Svg width={52} height={26} viewBox="0 0 52 26" fill="none" aria-hidden>
      {type === 'other' ? (
        [16, 26, 36].map((cx) => <Circle key={cx} cx={cx} cy={13} r={2} fill={tint} />)
      ) : (
        <>
          <Path
            d={`${TYPE_OUTLINE[type]}M3 19h6M17 19h18M43 19h6`}
            stroke={tint}
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <Circle cx={13} cy={19} r={3.6} stroke={tint} strokeWidth={1.6} />
          <Circle cx={39} cy={19} r={3.6} stroke={tint} strokeWidth={1.6} />
        </>
      )}
    </Svg>
  );
}

export function TypeTiles({
  label,
  types,
  names,
  value,
  onChange,
}: {
  label: string;
  types: readonly CustomerVehicleType[];
  names: Readonly<Record<CustomerVehicleType, string>>;
  value: CustomerVehicleType | null;
  onChange: (next: CustomerVehicleType | null) => void;
}) {
  return (
    <View style={styles.group} accessibilityRole="radiogroup" accessibilityLabel={label}>
      <AppText variant="label">{label}</AppText>
      <View style={styles.tiles}>
        {types.map((type) => {
          const selected = type === value;
          return (
            <Touchable
              key={type}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={names[type]}
              feedback="select"
              onPress={() => onChange(selected ? null : type)}
              containerStyle={styles.tileBox}
              style={[styles.tile, selected && styles.tileOn]}
              testID={`vehicle-type-${type}`}
            >
              <TypeIcon type={type} tint={selected ? color.primaryText : color.text} />
              <AppText variant="smallStrong" tone={selected ? 'primary' : 'default'} center>
                {names[type]}
              </AppText>
            </Touchable>
          );
        })}
      </View>
    </View>
  );
}

export function ColorSwatches({
  label,
  names,
  more,
  value,
  onChange,
}: {
  label: string;
  /** every colour key of 02 §8.4 with its name, «other» last */
  names: Readonly<Record<string, string>>;
  more: string;
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  const keys = Object.keys(names);
  // the chosen colour stays visible even when it is not one of the first nine
  const [all, setAll] = useState(() => value !== null && !VEHICLE_COLORS_FIRST.includes(value));
  const shown = all ? keys : keys.filter((k) => VEHICLE_COLORS_FIRST.includes(k));
  return (
    <View style={styles.group} accessibilityRole="radiogroup" accessibilityLabel={label}>
      <AppText variant="label">{label}</AppText>
      <View style={styles.swatches}>
        {shown.map((key) => {
          const selected = key === value;
          const paint = VEHICLE_COLOR_SWATCH[key];
          return (
            <Touchable
              key={key}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={names[key]}
              feedback="select"
              onPress={() => onChange(selected ? null : key)}
              containerStyle={styles.swatchBox}
              style={styles.swatch}
              testID={`vehicle-color-${key}`}
            >
              <View style={[styles.ring, selected && styles.ringOn]}>
                <View style={[styles.paint, paint ? { backgroundColor: paint } : styles.paintOther]}>
                  {selected ? (
                    <View style={styles.tick}>
                      <Icon name="check" size={14} tint={color.onPrimary} strokeWidth={3} />
                    </View>
                  ) : null}
                </View>
              </View>
              <AppText variant="caption" tone={selected ? 'primary' : 'default'} center>
                {names[key]}
              </AppText>
            </Touchable>
          );
        })}
        {all ? null : (
          <Touchable
            accessibilityRole="button"
            accessibilityLabel={more}
            onPress={() => setAll(true)}
            containerStyle={styles.swatchBox}
            style={styles.swatch}
            testID="vehicle-color-more"
          >
            <View style={styles.ring}>
              <View style={[styles.paint, styles.paintOther]}>
                <Icon name="plus" size={18} tint={color.text} />
              </View>
            </View>
            <AppText variant="caption" center>
              {more}
            </AppText>
          </Touchable>
        )}
      </View>
    </View>
  );
}

export function MakePicker({
  label,
  placeholder,
  names,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  names: Readonly<Record<string, string>>;
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const chosen = value ? names[value] : null;
  return (
    <View style={styles.group}>
      <AppText variant="label">{label}</AppText>
      <Touchable
        accessibilityRole="button"
        accessibilityLabel={chosen ? `${label}: ${chosen}` : label}
        accessibilityHint={placeholder}
        onPress={() => setOpen(true)}
        pressScale={1}
        style={styles.select}
        testID="vehicle-make"
      >
        <AppText tone={chosen ? 'default' : 'muted'}>{chosen ?? placeholder}</AppText>
        <Icon name="chevron-down" size={20} tint={color.textMuted} />
      </Touchable>
      <Sheet visible={open} onRequestClose={() => setOpen(false)}>
        <AppText variant="cardTitle" accessibilityRole="header">
          {label}
        </AppText>
        <ScrollView style={styles.list} accessibilityRole="radiogroup" accessibilityLabel={label}>
          {Object.entries(names).map(([key, name]) => {
            const selected = key === value;
            return (
              <Touchable
                key={key}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                accessibilityLabel={name}
                feedback="select"
                pressScale={1}
                onPress={() => {
                  onChange(selected ? null : key);
                  setOpen(false);
                }}
                style={[styles.option, selected && styles.optionOn]}
                testID={`vehicle-make-${key}`}
              >
                <AppText variant={selected ? 'bodyStrong' : 'body'} tone={selected ? 'primary' : 'default'}>
                  {name}
                </AppText>
                {selected ? <Icon name="check" size={20} tint={color.primaryText} /> : null}
              </Touchable>
            );
          })}
        </ScrollView>
      </Sheet>
    </View>
  );
}

const SWATCH = 40;

const styles = StyleSheet.create({
  group: { gap: space[2] },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
  tileBox: { width: '31.5%', flexGrow: 1 },
  tile: {
    minHeight: 76,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[1],
    paddingVertical: space[2],
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  tileOn: { borderWidth: 2, borderColor: color.primary, backgroundColor: color.primarySubtle },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', rowGap: space[3] },
  swatchBox: { width: '20%' },
  swatch: { alignItems: 'center', gap: space[1], minHeight: 64 },
  ring: {
    width: SWATCH + 8,
    height: SWATCH + 8,
    borderRadius: radius.full,
    borderWidth: 2,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringOn: { borderColor: color.primary },
  paint: {
    width: SWATCH,
    height: SWATCH,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: color.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  paintOther: { backgroundColor: color.surface2 },
  tick: {
    width: 22,
    height: 22,
    borderRadius: radius.full,
    backgroundColor: color.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  select: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space[4],
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: color.borderStrong,
    backgroundColor: color.surface,
  },
  list: { maxHeight: 420, marginTop: space[2] },
  option: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space[3],
    borderRadius: radius.md,
  },
  optionOn: { backgroundColor: color.primarySubtle },
});
