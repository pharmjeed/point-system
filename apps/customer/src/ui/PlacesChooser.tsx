/**
 * «أين تركن عادةً؟» — C-06 without a subscription (owner's option 2, DEC-639): the places that sell a subscription on
 * a map filling the screen, a search bar and the account button over it, and a bottom sheet holding the greeting,
 * the list of places (the chosen one marked by a 2 px primary border and a tick, never colour alone), «اشترك في هذا
 * المكان» for the chosen place (its page C-08, where the plans and «اشترك» are) and the shortcuts. Choosing a pin
 * chooses its row and the other way round; the list is the accessible path to every place.
 */
import type { VenuePublicCategory } from '@point/shared/customer';
import { useEffect, useRef, type ReactNode } from 'react';
import { ScrollView, StyleSheet, View, type ScrollViewInstance } from 'react-native';
import type { PlaceCard } from '../features/places';
import { color, layout, radius, shadow, space } from '../theme/tokens';
import { AppText } from './AppText';
import { Button } from './Button';
import { Banner } from './Controls';
import { Icon, type IconName } from './Icon';
import { PlacesMap } from './PlacesMap';
import { IconButton } from './ScreenHeader';
import { SkeletonList } from './Skeleton';
import { Touchable } from './Touchable';

const CATEGORY_ICON: Record<VenuePublicCategory, IconName> = {
  office: 'building',
  hospital: 'hospital',
  mall: 'shopping-bag',
  club: 'dumbbell',
  hotel: 'bed-double',
  hall: 'party-popper',
  residential: 'house',
  other: 'map-pin',
};

/** The badge of each category: one colour family per kind of place, from the brand's roles. */
const CATEGORY_TINT: Record<VenuePublicCategory, string> = {
  office: color.primary,
  hospital: color.success,
  mall: color.warning,
  club: color.surfaceInverse,
  hotel: color.primaryHover,
  hall: color.danger,
  residential: color.successText,
  other: color.primaryPressed,
};

/** The search bar over the map's top and the sheet lapping over its bottom: no pin goes under them. */
const MAP_INSETS = { top: 64, bottom: 24 };

export interface PlacesChooserText {
  greeting: string;
  title: string;
  hint: string;
  search: string;
  account: string;
  mapLabel: string;
  count: string;
  subscribe: string;
  empty: string;
  loading: string;
}

export function PlacesChooser({
  places,
  loading,
  failure,
  selected,
  onSelect,
  onSubscribe,
  onSearch,
  onAccount,
  shortcuts,
  text,
}: {
  places: readonly PlaceCard[];
  loading: boolean;
  failure: string | null;
  selected: string | null;
  onSelect: (id: string) => void;
  onSubscribe: (id: string) => void;
  onSearch: () => void;
  onAccount: () => void;
  shortcuts: ReactNode;
  text: PlacesChooserText;
}) {
  // the chosen row comes into view in the sheet (a pin chosen on the map)
  const list = useRef<ScrollViewInstance>(null);
  const rowY = useRef(new Map<string, number>());
  useEffect(() => {
    const y = selected ? rowY.current.get(selected) : undefined;
    if (y !== undefined) list.current?.scrollTo({ y: Math.max(0, y - space[2]), animated: true });
  }, [selected]);

  return (
    <View style={styles.root} testID="home-places">
      {/* the map takes the part of the screen above the sheet, so every pin stays in view */}
      <View style={styles.mapArea}>
        <PlacesMap
          places={places}
          selected={selected}
          onSelect={onSelect}
          label={text.mapLabel}
          insets={MAP_INSETS}
        />
        <View style={styles.topBar}>
          <Touchable
            accessibilityRole="search"
            accessibilityLabel={text.search}
            onPress={onSearch}
            pressScale={0.98}
            containerStyle={styles.flex}
            style={styles.search}
            testID="home-search"
          >
            <Icon name="search" size={20} tint={color.textMuted} />
            <AppText tone="muted">{text.search}</AppText>
          </Touchable>
          <IconButton icon="user" label={text.account} onPress={onAccount} testID="home-account" />
        </View>
      </View>

      <View style={styles.sheet}>
        <View style={styles.grab} aria-hidden />
        <View style={styles.head}>
          <AppText tone="muted">{text.greeting}</AppText>
          <AppText variant="title" accessibilityRole="header">
            {text.title}
          </AppText>
          <AppText variant="small" tone="muted">
            {places.length ? text.count : text.hint}
          </AppText>
        </View>
        {failure ? <Banner tone="danger">{failure}</Banner> : null}
        <ScrollView ref={list} style={styles.list} contentContainerStyle={styles.listIn} nestedScrollEnabled>
          {loading && places.length === 0 ? (
            <SkeletonList label={text.loading} count={2} lines={2} />
          ) : places.length === 0 && !failure ? (
            <AppText tone="muted" center>
              {text.empty}
            </AppText>
          ) : (
            <View accessibilityRole="radiogroup" accessibilityLabel={text.title} style={styles.rows}>
              {places.map((p) => {
                const on = p.id === selected;
                return (
                  <View key={p.id} onLayout={(e) => rowY.current.set(p.id, e.nativeEvent.layout.y)}>
                    <Touchable
                      accessibilityRole="radio"
                      accessibilityState={{ selected: on }}
                      accessibilityLabel={[p.title, p.facts, p.price].filter(Boolean).join('، ')}
                      onPress={() => onSelect(p.id)}
                      feedback="select"
                      pressScale={0.98}
                      style={[styles.row, on && styles.rowOn]}
                      testID={`place-${p.id}`}
                    >
                      <View style={[styles.thumb, { backgroundColor: CATEGORY_TINT[p.category] }]}>
                        <Icon name={CATEGORY_ICON[p.category]} size={24} tint={color.onPrimary} />
                      </View>
                      <View style={styles.flex}>
                        <AppText variant="bodyStrong" numberOfLines={1}>
                          {p.title}
                        </AppText>
                        {p.facts ? (
                          <AppText variant="small" tone="muted" numberOfLines={1}>
                            {p.facts}
                          </AppText>
                        ) : null}
                        <AppText variant="smallStrong">{p.price}</AppText>
                      </View>
                      {on ? <Icon name="circle-check" size={24} tint={color.primary} /> : null}
                    </Touchable>
                  </View>
                );
              })}
            </View>
          )}
        </ScrollView>
        <Button
          label={text.subscribe}
          onPress={() => selected && onSubscribe(selected)}
          disabled={!selected}
          testID="home-subscribe"
        />
        {shortcuts}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.surface },
  mapArea: { flex: 1, minHeight: 200, backgroundColor: color.surface2 },
  flex: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    paddingHorizontal: space[4],
    paddingTop: space[3],
  },
  search: {
    minHeight: layout.touchMin + 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    paddingHorizontal: space[4],
    borderRadius: radius.lg,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    boxShadow: shadow.md,
  },
  sheet: {
    // the rounded top laps over the map's lower edge
    marginTop: -space[5],
    maxHeight: '58%',
    gap: space[3],
    paddingHorizontal: space[4],
    paddingTop: space[2],
    paddingBottom: space[3],
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    backgroundColor: color.surface,
    boxShadow: shadow.lg,
  },
  grab: {
    alignSelf: 'center',
    width: 40,
    height: 5,
    borderRadius: radius.full,
    backgroundColor: color.border,
  },
  head: { gap: space[1] },
  list: { flexGrow: 0, flexShrink: 1 },
  listIn: { paddingBottom: space[1] },
  rows: { gap: space[2] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    padding: space[3],
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  rowOn: { borderWidth: 2, borderColor: color.primary, backgroundColor: color.primarySubtle },
  thumb: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
