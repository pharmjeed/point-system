/**
 * C-07 map view (V2-012, DEC-506) on react-native-maps: Apple Maps on iOS (no key), Google Maps on Android only
 * when the build carries a key — the screen does not mount this component otherwise (`mapAvailable`). One pin per
 * listed location with coordinates; the callout opens C-08. The list stays the accessible way to every location
 * (a map is not reachable by screen readers pin by pin), so the map is an addition, never the only path.
 */
import MapView, { Marker } from 'react-native-maps';
import { StyleSheet, View } from 'react-native';
import { regionFor, type MapPin } from '../features/locations';
import { color, radius } from '../theme/tokens';

export function LocationsMap({
  pins,
  label,
  onOpen,
}: {
  pins: readonly MapPin[];
  label: string;
  onOpen: (venueId: string) => void;
}) {
  return (
    <View style={styles.frame} accessibilityLabel={label}>
      <MapView style={styles.map} initialRegion={regionFor(pins)} showsPointsOfInterests={false}>
        {pins.map((p) => (
          <Marker
            key={p.id}
            identifier={p.id}
            coordinate={{ latitude: p.lat, longitude: p.lng }}
            title={p.title}
            description={p.description}
            pinColor={color.primary}
            onCalloutPress={() => onOpen(p.id)}
          />
        ))}
      </MapView>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    height: 360,
    borderRadius: radius.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: color.border,
  },
  map: { flex: 1 },
});
