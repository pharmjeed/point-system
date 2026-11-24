/**
 * The drawn map of «اختر مكانك» (DEC-639): the places that sell a subscription as price pins placed by their
 * coordinates (north up, `pinSpots`), over a quiet background of streets that are decoration only. Used where the
 * real map is not available (the web build, Android without a Google Maps key, DEC-506) so the screen looks and
 * works the same everywhere. Tapping a pin chooses the place; the chosen pin is navy and larger. The sheet's list
 * is the accessible path to every place (a map is not reachable pin by pin by screen readers), so the pins are
 * buttons with the place's name and price, and the background is hidden.
 */
import { useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { pinSpots, type PlaceCard } from '../features/places';
import { color, font, fontSize, radius, space } from '../theme/tokens';
import { AppText } from './AppText';
import { Touchable } from './Touchable';

export function PlacesDrawnMap({
  places,
  selected,
  onSelect,
  label,
  insets,
}: {
  places: readonly PlaceCard[];
  selected: string | null;
  onSelect: (id: string) => void;
  label: string;
  /** the room taken over the map by what sits on it (the search bar at the top, the sheet's lap at the bottom) */
  insets?: { top: number; bottom: number };
}) {
  const inset = insets ?? { top: 0, bottom: 0 };
  const byId = new Map(places.map((p) => [p.id, p]));
  const [box, setBox] = useState({ w: 0, h: 0 });
  const onLayout = (e: LayoutChangeEvent) =>
    setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });
  return (
    <View style={StyleSheet.absoluteFill} accessibilityLabel={label} onLayout={onLayout}>
      <View style={StyleSheet.absoluteFill} pointerEvents="none" accessible={false} aria-hidden>
        <Svg width="100%" height="100%" viewBox="0 0 100 160" preserveAspectRatio="xMidYMid slice">
          <Rect x="0" y="0" width="100" height="160" fill={color.surface2} />
          {/* a few streets and a ring road: decoration, not the city */}
          <Path d="M-5 52 L105 40" stroke={color.surface} strokeWidth="3.2" />
          <Path d="M-5 104 L105 118" stroke={color.surface} strokeWidth="2.6" />
          <Path d="M38 -5 L50 165" stroke={color.surface} strokeWidth="3.2" />
          <Path d="M78 -5 L70 165" stroke={color.surface} strokeWidth="2" />
          <Path d="M8 -5 L20 165" stroke={color.surface} strokeWidth="1.6" />
          <Path
            d="M50 30 C80 30 92 60 90 85 C88 115 70 135 45 132 C20 129 8 105 10 80 C12 52 25 30 50 30 Z"
            stroke={color.surface}
            strokeWidth="1.6"
            fill="none"
          />
        </Svg>
      </View>
      {(box.w ? pinSpots(places) : []).map((spot) => {
        const place = byId.get(spot.id);
        if (!place) return null;
        const on = spot.id === selected;
        return (
          <View
            key={spot.id}
            style={[
              styles.anchor,
              {
                // kept inside the map's width: a pin near the edge never runs off the screen
                left: Math.min(Math.max(0, spot.x * box.w - PIN_W / 2), Math.max(0, box.w - PIN_W)),
                top: inset.top + spot.y * Math.max(0, box.h - inset.top - inset.bottom) - PIN_H / 2,
              },
              on && styles.front,
            ]}
          >
            <Touchable
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${place.title}، ${place.price}`}
              onPress={() => onSelect(spot.id)}
              feedback="select"
              pressScale={0.94}
              testID={`place-pin-${spot.id}`}
              style={[styles.pin, on && styles.pinOn]}
            >
              <AppText numberOfLines={1} style={[styles.pinText, on && styles.pinTextOn]}>
                {place.pin}
              </AppText>
            </Touchable>
          </View>
        );
      })}
    </View>
  );
}

/** The box each pin is centred in (wide enough for «3,450 ر.س» on one line). */
const PIN_W = 112;
const PIN_H = 44;

const styles = StyleSheet.create({
  anchor: {
    position: 'absolute',
    width: PIN_W,
    height: PIN_H,
    alignItems: 'center',
    justifyContent: 'center',
  },
  front: { zIndex: 2 },
  pin: {
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space[3],
    borderRadius: radius.full,
    backgroundColor: color.primary,
    borderWidth: 2,
    borderColor: color.surface,
  },
  pinOn: { backgroundColor: color.surfaceInverse, minHeight: 38, paddingHorizontal: space[4] },
  pinText: { ...fontSize.sm, fontFamily: font.bold, color: color.onPrimary },
  pinTextOn: { ...fontSize.base },
});
