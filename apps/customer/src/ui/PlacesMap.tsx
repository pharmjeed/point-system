/**
 * The map of «اختر مكانك» (DEC-639) on a phone: the real map (react-native-maps: Apple Maps on iOS, Google Maps on
 * Android when the build carries a key, DEC-506) with a price pin per place; tapping a pin chooses the place. Where
 * the real map is not available it is the drawn one (`PlacesDrawnMap`), the same pins on a quiet background.
 */
import { Platform, StyleSheet, View } from 'react-native';
import MapView, { Marker } from 'react-native-maps';
import { appConfig } from '../config';
import { mapAvailable, regionFor, type MapPin } from '../features/locations';
import type { PlaceCard } from '../features/places';
import { color, font, fontSize, radius, space } from '../theme/tokens';
import { AppText } from './AppText';
import { PlacesDrawnMap } from './PlacesDrawnMap';

export function PlacesMap(props: {
  places: readonly PlaceCard[];
  selected: string | null;
  onSelect: (id: string) => void;
  label: string;
  insets?: { top: number; bottom: number };
}) {
  if (!mapAvailable(Platform.OS, appConfig)) return <PlacesDrawnMap {...props} />;
  const { places, selected, onSelect, label, insets } = props;
  const pins: MapPin[] = places.flatMap((p) =>
    p.lat !== null && p.lng !== null
      ? [{ id: p.id, title: p.title, description: p.price, lat: p.lat, lng: p.lng }]
      : [],
  );
  return (
    <View style={StyleSheet.absoluteFill} accessibilityLabel={label}>
      <MapView
        style={StyleSheet.absoluteFill}
        initialRegion={regionFor(pins)}
        showsPointsOfInterests={false}
        mapPadding={{ top: insets?.top ?? 0, bottom: insets?.bottom ?? 0, left: 0, right: 0 }}
      >
        {pins.map((p) => {
          const on = p.id === selected;
          const place = places.find((x) => x.id === p.id);
          return (
            <Marker
              key={p.id}
              identifier={p.id}
              coordinate={{ latitude: p.lat, longitude: p.lng }}
              onPress={() => onSelect(p.id)}
              accessibilityLabel={`${p.title}، ${p.description}`}
              zIndex={on ? 2 : 1}
            >
              <View style={[styles.pin, on && styles.pinOn]}>
                <AppText style={[styles.pinText, on && styles.pinTextOn]}>{place?.pin ?? ''}</AppText>
              </View>
            </Marker>
          );
        })}
      </MapView>
    </View>
  );
}

const styles = StyleSheet.create({
  pin: {
    minHeight: 32,
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
