/**
 * C-07 المواقع (V2-012): search, the filters of 01 (subscribed / accepts subscription / open now), the list with
 * «فتح في الخرائط» on every location, and a map view where the build can draw one (Apple Maps on iOS; Google Maps
 * on Android only with a key in the build, DEC-506). A location opens C-08.
 */
import type { CustomerLocationSummary } from '@point/shared/customer';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, View } from 'react-native';
import { appConfig } from '../config';
import { errorText } from '../features/errorText';
import { locationRow } from '../features/home';
import {
  LOCATION_FILTER_CHIPS,
  emptyText,
  locationsQuery,
  mapAvailable,
  mapPins,
  mergePage,
  type LocationFilterChip,
} from '../features/locations';
import { useI18n } from '../i18n/I18nProvider';
import { useSession } from '../session/SessionProvider';
import { color, radius, space } from '../theme/tokens';
import { AppText } from '../ui/AppText';
import { Button } from '../ui/Button';
import { Banner, Card, ChoiceChips } from '../ui/Controls';
import { DevBanner } from '../ui/DevBanner';
import { Field } from '../ui/Field';
import { LocationsMap } from '../ui/LocationsMap';
import { openInMaps } from '../ui/openLinks';
import { Screen } from '../ui/Screen';
import { ScreenHeader } from '../ui/ScreenHeader';

type LocationsView = 'list' | 'map';

export default function Locations() {
  const { t, locale } = useI18n();
  const session = useSession();
  const router = useRouter();
  const canMap = mapAvailable(Platform.OS, appConfig);
  const [search, setSearch] = useState('');
  const [chip, setChip] = useState<LocationFilterChip>('all');
  const [view, setView] = useState<LocationsView>('list');
  const [items, setItems] = useState<CustomerLocationSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState<'first' | 'more' | null>('first');
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const request = useRef(0);

  const load = useCallback(
    async (more: boolean, from: string | null) => {
      const id = ++request.current;
      setLoading(more ? 'more' : 'first');
      try {
        const page = await session.api.locations(locationsQuery(search, chip, more ? from : null));
        if (id !== request.current) return; // a newer search answered first
        setItems((prev) => (more ? mergePage(prev, page.items) : page.items));
        setCursor(page.nextCursor);
        setFailure(null);
      } catch (e) {
        if (id === request.current) setFailure(errorText(e, t, locale));
      } finally {
        if (id === request.current) setLoading(null);
      }
    },
    [session.api, search, chip, t, locale],
  );

  // search as the customer types, a moment after the last key
  useEffect(() => {
    const timer = setTimeout(() => void load(false, null), search ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  const open = (venueId: string) => router.push({ pathname: '/location/[venueId]', params: { venueId } });

  const maps = async (loc: CustomerLocationSummary, title: string) => {
    setNotice(null);
    if (!(await openInMaps({ lat: loc.lat, lng: loc.lng, name: title })))
      setNotice(t.locations.openInMapsFailed);
  };

  return (
    <Screen>
      <ScreenHeader title={t.locations.title} backLabel={t.common.back} onBack={() => router.back()} />
      <DevBanner />
      <Field
        label={t.locations.searchLabel}
        value={search}
        onChangeText={setSearch}
        placeholder={t.locations.searchPlaceholder}
        returnKeyType="search"
        maxLength={60}
        autoCorrect={false}
      />
      <ChoiceChips<LocationFilterChip>
        label={t.locations.filterLabel}
        options={LOCATION_FILTER_CHIPS.map((value) => ({ value, label: t.locations.filters[value] }))}
        value={chip}
        onChange={(next) => setChip(next ?? 'all')}
      />
      {canMap ? (
        <ChoiceChips<LocationsView>
          label={t.locations.viewLabel}
          options={[
            { value: 'list', label: t.locations.viewList },
            { value: 'map', label: t.locations.viewMap },
          ]}
          value={view}
          onChange={(next) => setView(next ?? 'list')}
        />
      ) : Platform.OS === 'android' ? (
        <Banner tone="info">{t.locations.mapUnavailable}</Banner>
      ) : null}
      {failure ? <Banner tone="danger">{`${t.locations.loadFailed} ${failure}`}</Banner> : null}
      {notice ? <Banner tone="warning">{notice}</Banner> : null}
      {loading === 'first' && items.length === 0 ? (
        <ActivityIndicator color={color.primary} accessibilityLabel={t.common.loading} />
      ) : null}
      {!loading && !failure && items.length === 0 ? (
        <Card>
          <AppText tone="muted">{emptyText(search, chip, t)}</AppText>
        </Card>
      ) : null}
      {canMap && view === 'map' && items.length > 0 ? (
        <LocationsMap pins={mapPins(items, t, locale)} label={t.locations.viewMap} onOpen={open} />
      ) : null}
      {items.map((loc) => {
        const row = locationRow(loc, t, locale);
        return (
          <View key={row.id} style={styles.item}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${row.title}${t.locations.listSeparator}${row.operator}`}
              accessibilityHint={t.locations.details}
              onPress={() => open(row.id)}
              style={({ pressed }) => [styles.press, pressed && { backgroundColor: color.primarySubtle }]}
            >
              <AppText variant="bodyStrong">{row.title}</AppText>
              <AppText variant="small" tone="muted">
                {row.operator}
              </AppText>
              {row.facts.length ? <AppText variant="small">{row.facts.join(' · ')}</AppText> : null}
              {row.price ? (
                <AppText variant="small" tone="primary">
                  {row.price}
                </AppText>
              ) : null}
            </Pressable>
            {loc.lat !== null && loc.lng !== null ? (
              <Button
                label={t.locations.openInMaps}
                variant="ghost"
                size="md"
                onPress={() => void maps(loc, row.title)}
              />
            ) : null}
          </View>
        );
      })}
      {cursor ? (
        <Button
          label={t.locations.loadMore}
          variant="secondary"
          size="md"
          loading={loading === 'more'}
          loadingLabel={t.common.loading}
          onPress={() => void load(true, cursor)}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  item: {
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.border,
    overflow: 'hidden',
  },
  press: { padding: space[4], gap: space[1] },
});
