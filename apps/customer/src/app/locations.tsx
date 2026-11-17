/**
 * C-07 المواقع (V2-012): search, the filters of 01 (subscribed / accepts subscription / open now), the list with
 * «فتح في الخرائط» on every location, and a map view where the build can draw one (Apple Maps on iOS; Google Maps
 * on Android only with a key in the build, DEC-506). A location opens C-08.
 *
 * V2-UX (DEC-577): a search field with its icon, the filter chips, location cards (`LocationCard`: open-now chip,
 * distance, «يقبل الاشتراك», «مشترك» for the account's own subscriptions — read once from C-14's list — and the
 * «from» price), skeletons while loading and an empty state with its icon.
 */
import type { CustomerLocationSummary } from '@point/shared/customer';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
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
import { FadeIn } from '../ui/Animated';
import { Button } from '../ui/Button';
import { Banner, ChoiceChips } from '../ui/Controls';
import { DevBanner } from '../ui/DevBanner';
import { EmptyState } from '../ui/EmptyState';
import { Field } from '../ui/Field';
import { LocationCard } from '../ui/LocationCard';
import { LocationsMap } from '../ui/LocationsMap';
import { openInMaps } from '../ui/openLinks';
import { Screen } from '../ui/Screen';
import { ScreenHeader } from '../ui/ScreenHeader';
import { SkeletonList } from '../ui/Skeleton';

type LocationsView = 'list' | 'map';

export default function Locations() {
  const { t, locale } = useI18n();
  const session = useSession();
  const router = useRouter();
  // «اشترك ووفّر» on C-06 opens the list on «يقبل الاشتراك» (V2-UX option B, DEC-582)
  const { filter } = useLocalSearchParams<{ filter?: string }>();
  const canMap = mapAvailable(Platform.OS, appConfig);
  const [search, setSearch] = useState('');
  const [chip, setChip] = useState<LocationFilterChip>(() =>
    LOCATION_FILTER_CHIPS.includes(filter as LocationFilterChip) ? (filter as LocationFilterChip) : 'all',
  );
  const [view, setView] = useState<LocationsView>('list');
  const [items, setItems] = useState<CustomerLocationSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState<'first' | 'more' | null>('first');
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const request = useRef(0);
  const [subscribed, setSubscribed] = useState<ReadonlySet<string>>(new Set());

  // the «مشترك» badge: the account's live subscriptions (C-14's read), best effort
  useEffect(() => {
    let alive = true;
    session.api
      .subscriptions()
      .then((list) => {
        const live = list.filter((s) => s.status !== 'canceled' && s.status !== 'expired');
        if (alive) setSubscribed(new Set(live.map((s) => s.venue_id)));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [session.api]);

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
        icon="search"
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
      {loading === 'first' && items.length === 0 ? <SkeletonList label={t.common.loading} count={3} /> : null}
      {!loading && !failure && items.length === 0 ? (
        <EmptyState icon="map-pin" text={emptyText(search, chip, t)} />
      ) : null}
      {canMap && view === 'map' && items.length > 0 ? (
        <LocationsMap pins={mapPins(items, t, locale)} label={t.locations.viewMap} onOpen={open} />
      ) : null}
      {items.map((loc, i) => {
        const row = locationRow(loc, t, locale);
        return (
          <FadeIn key={row.id} index={i}>
            <LocationCard
              loc={loc}
              row={row}
              subscribed={subscribed.has(loc.venue_id)}
              accessibilityLabel={`${row.title}${t.locations.listSeparator}${row.operator}`}
              onPress={() => open(row.id)}
              footer={
                loc.lat !== null && loc.lng !== null ? (
                  <Button
                    label={t.locations.openInMaps}
                    icon="map"
                    variant="ghost"
                    size="md"
                    onPress={() => void maps(loc, row.title)}
                  />
                ) : null
              }
            />
          </FadeIn>
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
