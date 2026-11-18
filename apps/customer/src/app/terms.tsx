/**
 * C-24 «الشروط والأحكام» (DEC-614 … DEC-616): the full, versioned terms of the app (src/legal) — the title, «آخر
 * تحديث · الإصدار», a short introduction, the table of contents (each row jumps to its section), then the numbered
 * sections. A bar under the header stays on top while reading and names the current section, with «المحتويات» to go
 * back to the table; «أعلى الصفحة» appears once the reader is down the page. Jumps are instant under reduce motion.
 *
 * Opened from: C-19 «الشروط والأحكام», C-04 «اقرأ النص», C-09 «اطّلع على الشروط والأحكام» (`?venueId&planId`: the
 * plan's own values in the clauses) and the C-14 card «الشروط» (`?subscriptionId`). Without a plan, or when it cannot
 * be read, the clauses keep their generic wording — the text never waits for the network.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewInstance,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { termsView, type TermsPlan } from '../features/terms';
import { fmt } from '../i18n';
import { useI18n } from '../i18n/I18nProvider';
import { useSession } from '../session/SessionProvider';
import { color, font, fontSize, layout, radius, shadow, space } from '../theme/tokens';
import { AppText } from '../ui/AppText';
import { Banner, Card } from '../ui/Controls';
import { fromEnd } from '../ui/direction';
import { Icon } from '../ui/Icon';
import { useReducedMotion } from '../ui/motion';
import { IconButton, ScreenHeader } from '../ui/ScreenHeader';
import { Touchable } from '../ui/Touchable';

/** Past this many points down the page, «أعلى الصفحة» shows. */
const TOP_AFTER = 480;

export default function Terms() {
  const params = useLocalSearchParams<{ venueId?: string; planId?: string; subscriptionId?: string }>();
  const { t, locale, brand } = useI18n();
  const session = useSession();
  const router = useRouter();
  const reduced = useReducedMotion();
  const [plan, setPlan] = useState<TermsPlan | null>(null);
  const [current, setCurrent] = useState<number | null>(null);
  const [showTop, setShowTop] = useState(false);
  const scroll = useRef<ScrollViewInstance>(null);
  const offsets = useRef<Record<string, number>>({});
  const tocY = useRef(0);
  const barH = useRef(56);

  // the plan the terms were opened from: its values replace the generic ones once read (never blocks the text)
  const { venueId, planId, subscriptionId } = params;
  useEffect(() => {
    let cancelled = false;
    if (venueId && planId)
      session.api
        .location(venueId)
        .then((loc) => {
          const row = loc.plans.find((p) => p.plan_id === planId);
          if (!cancelled && row)
            setPlan({
              name: row.name_ar,
              policy: row.policy,
              netHalalas: row.monthly_breakdown?.net_halalas ?? null,
            });
        })
        .catch(() => undefined);
    else if (subscriptionId)
      session.api
        .subscription(subscriptionId)
        .then((s) => {
          if (!cancelled)
            setPlan({
              name: locale === 'en' && s.plan_name_en ? s.plan_name_en : s.plan_name_ar,
              policy: s.policy,
              netHalalas: null,
            });
        })
        .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [venueId, planId, subscriptionId, session.api, locale]);

  const view = useMemo(() => termsView(locale, brand, t, plan), [locale, brand, t, plan]);

  const scrollTo = (y: number) => scroll.current?.scrollTo({ y: Math.max(0, y), animated: !reduced });
  const jump = (id: string) => {
    const y = offsets.current[id];
    if (y !== undefined) scrollTo(y - barH.current - space[2]);
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    setShowTop(y > TOP_AFTER);
    const line = y + barH.current + space[4];
    let at: number | null = null;
    for (const s of view.sections) {
      const top = offsets.current[s.id];
      if (top !== undefined && top <= line) at = s.number;
    }
    setCurrent(at);
  };

  const here = current !== null ? view.sections[current - 1] : undefined;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <ScrollView
        ref={scroll}
        stickyHeaderIndices={[1]}
        onScroll={onScroll}
        scrollEventThrottle={48}
        contentContainerStyle={styles.scroll}
        testID="terms-scroll"
      >
        <View style={styles.row}>
          <View style={styles.column}>
            <ScreenHeader title={view.title} backLabel={t.common.back} onBack={() => router.back()} />
            <AppText variant="small" tone="muted" testID="terms-updated">
              {view.updated}
            </AppText>
            {view.planNote ? <Banner tone="info">{view.planNote}</Banner> : null}
            <AppText style={styles.intro}>{view.intro}</AppText>
            <View
              onLayout={(e: LayoutChangeEvent) => {
                tocY.current = e.nativeEvent.layout.y;
              }}
            >
              <Card>
                <View style={styles.tocHead}>
                  <Icon name="list-ordered" size={20} tint={color.primary} />
                  <AppText variant="cardTitle" accessibilityRole="header" style={styles.flex}>
                    {view.contents}
                  </AppText>
                </View>
                {view.sections.map((s) => (
                  <Touchable
                    key={s.id}
                    accessibilityRole="button"
                    accessibilityLabel={fmt(t.terms.jump, { n: s.number, title: s.title })}
                    onPress={() => jump(s.id)}
                    pressScale={1}
                    testID={`terms-toc-${s.id}`}
                    style={({ pressed }) => [styles.tocRow, pressed && { backgroundColor: color.surface2 }]}
                  >
                    <AppText variant="smallStrong" tone="primary" style={styles.tocNumber}>
                      {s.number}
                    </AppText>
                    <AppText style={styles.flex}>{s.title}</AppText>
                    <Icon name="go" size={18} tint={color.textMuted} />
                  </Touchable>
                ))}
              </Card>
            </View>
          </View>
        </View>

        {/* the sticky bar: the section being read, and the way back to the contents */}
        <View
          style={styles.barWrap}
          onLayout={(e: LayoutChangeEvent) => {
            barH.current = e.nativeEvent.layout.height;
          }}
        >
          <View style={styles.bar}>
            <AppText variant="smallStrong" numberOfLines={1} style={styles.flex} testID="terms-current">
              {here ? `${here.number}. ${here.title}` : view.title}
            </AppText>
            <Touchable
              accessibilityRole="button"
              accessibilityLabel={view.contents}
              onPress={() => scrollTo(tocY.current - space[2])}
              pressScale={0.95}
              testID="terms-contents"
              style={({ pressed }) => [styles.barAction, pressed && { backgroundColor: color.primarySubtle }]}
            >
              <Icon name="list-ordered" size={18} tint={color.primaryText} />
              <AppText variant="smallStrong" tone="primary">
                {view.contents}
              </AppText>
            </Touchable>
          </View>
        </View>

        {view.sections.map((s) => (
          <View
            key={s.id}
            style={styles.row}
            onLayout={(e: LayoutChangeEvent) => {
              offsets.current[s.id] = e.nativeEvent.layout.y;
            }}
            testID={`terms-section-${s.id}`}
          >
            <View style={[styles.column, styles.section]}>
              <AppText variant="cardTitle" accessibilityRole="header">
                {`${s.number}. ${s.title}`}
              </AppText>
              {s.clauses.map((c) => (
                <View key={c.number} style={styles.clause}>
                  <AppText variant="smallStrong" tone="muted" style={styles.clauseNumber}>
                    {c.number}
                  </AppText>
                  <AppText style={styles.clauseText}>{c.text}</AppText>
                </View>
              ))}
            </View>
          </View>
        ))}

        <View style={styles.row}>
          <AppText variant="small" tone="muted" center style={styles.column}>
            {view.updated}
          </AppText>
        </View>
      </ScrollView>

      {showTop ? (
        <View style={[styles.top, fromEnd(space[4])]} pointerEvents="box-none">
          <IconButton icon="arrow-up" label={t.terms.top} onPress={() => scrollTo(0)} testID="terms-top" />
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.bg },
  flex: { flex: 1 },
  scroll: { paddingBottom: space[12] },
  // each child of the scroller spans the width (the sticky bar's background too); the text keeps the shell's width
  row: { width: '100%', alignItems: 'center', paddingHorizontal: space[4] },
  column: { width: '100%', maxWidth: layout.shellMaxW, gap: space[3] },
  intro: { ...fontSize.base, color: color.text },
  tocHead: { flexDirection: 'row', alignItems: 'center', gap: space[2], marginBottom: space[1] },
  tocRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    minHeight: layout.touchMin,
    paddingHorizontal: space[1],
    borderRadius: radius.sm,
  },
  tocNumber: { minWidth: space[6], textAlign: 'center' },
  barWrap: {
    width: '100%',
    alignItems: 'center',
    backgroundColor: color.bg,
    paddingHorizontal: space[4],
    paddingVertical: space[2],
  },
  bar: {
    width: '100%',
    maxWidth: layout.shellMaxW,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    backgroundColor: color.surface,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: color.border,
    paddingStart: space[4],
    paddingEnd: space[1],
    minHeight: layout.touchMin,
    boxShadow: shadow.sm,
  },
  barAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1],
    paddingHorizontal: space[3],
    minHeight: layout.touchMin - space[2],
    borderRadius: radius.full,
  },
  section: { paddingTop: space[6], gap: space[3] },
  clause: { flexDirection: 'row', gap: space[3], alignItems: 'flex-start' },
  clauseNumber: { minWidth: space[8], paddingTop: 1, fontFamily: font.semibold },
  clauseText: { flex: 1, ...fontSize.base, color: color.text },
  top: { position: 'absolute', bottom: space[6] },
});
