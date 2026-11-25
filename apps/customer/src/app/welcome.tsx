/**
 * C-01 الترحيب (owner's option 4): an interactive picture, the welcome, the current promise in one line, the three
 * promises as small cards in one row, and «ابدأ» in the sticky bottom sheet (to C-02: one sign-in for new and
 * returning customers, V2-D11). Shown once per install.
 *
 * The picture (WelcomeHero) shows one scene per promise. The scene advances on its own every few seconds, on a tap
 * on the picture, or on a tap on a card; any tap restarts the timer. Under reduce motion it never advances by
 * itself (03 §2.7). The selected card is marked by its border and its filled badge, not by colour alone.
 */
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useI18n } from '../i18n/I18nProvider';
import { useSession } from '../session/SessionProvider';
import { color, radius, shadow, space } from '../theme/tokens';
import { FadeIn } from '../ui/Animated';
import { AppText } from '../ui/AppText';
import { Button } from '../ui/Button';
import { IconBadge } from '../ui/Controls';
import type { IconName } from '../ui/Icon';
import { useReducedMotion } from '../ui/motion';
import { Screen } from '../ui/Screen';
import { Touchable } from '../ui/Touchable';
import { WELCOME_SCENES, WelcomeHero } from '../ui/WelcomeHero';

/** One icon per promise of C-01, in the order of `t.welcome.cards`. */
const CARD_ICONS: readonly IconName[] = ['car-front', 'smartphone', 'badge-percent'];

/** How long a scene stays before the next one (ms). */
export const WELCOME_SCENE_MS = 4500;

export default function Welcome() {
  const { t, f, brand } = useI18n();
  const session = useSession();
  const router = useRouter();
  const reduced = useReducedMotion();
  const [scene, setScene] = useState(0);
  // bumped on every tap, so the timer restarts even when the tapped card is already the current one
  const [touch, setTouch] = useState(0);

  useEffect(() => {
    if (reduced) return;
    const timer = setTimeout(() => setScene((s) => (s + 1) % WELCOME_SCENES), WELCOME_SCENE_MS);
    return () => clearTimeout(timer);
  }, [scene, touch, reduced]);

  const show = (next: number) => {
    setScene(next % WELCOME_SCENES);
    setTouch((n) => n + 1);
  };

  const go = async () => {
    await session.markWelcomeSeen();
    router.replace('/phone');
  };

  const current = t.welcome.cards[scene] ?? t.welcome.cards[0];

  return (
    <Screen footer={<Button label={t.welcome.start} icon="go" onPress={go} testID="welcome-start" />}>
      <WelcomeHero
        scene={scene}
        onPress={() => show(scene + 1)}
        label={current?.title ?? ''}
        hint={t.welcome.heroHint}
        brand={brand}
      />
      <View style={styles.intro}>
        <AppText variant="title" center accessibilityRole="header">
          {f(t.welcome.title)}
        </AppText>
        <FadeIn swapKey={scene}>
          <AppText tone="muted" center accessibilityLiveRegion="polite" testID="welcome-caption">
            {current?.body}
          </AppText>
        </FadeIn>
      </View>
      <View style={styles.row}>
        {t.welcome.cards.map((card, i) => {
          const selected = i === scene;
          return (
            <FadeIn key={card.title} index={i + 1} style={styles.flex}>
              <Touchable
                onPress={() => show(i)}
                feedback="select"
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={card.title}
                testID={`welcome-card-${i}`}
                containerStyle={styles.flex}
                style={[styles.card, selected && styles.cardOn]}
              >
                <IconBadge
                  name={CARD_ICONS[i] ?? 'circle-check'}
                  size={46}
                  tint={selected ? color.onPrimary : color.primaryText}
                  bg={selected ? color.primary : color.primarySubtle}
                />
                <AppText variant="smallStrong" center>
                  {card.title}
                </AppText>
              </Touchable>
            </FadeIn>
          );
        })}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: { gap: space[2], paddingTop: space[2] },
  row: { flexDirection: 'row', gap: space[2], alignItems: 'stretch' },
  flex: { flex: 1 },
  card: {
    flex: 1,
    alignItems: 'center',
    gap: space[2],
    paddingVertical: space[4],
    paddingHorizontal: space[2],
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.border,
    boxShadow: shadow.sm,
  },
  // a thicker border in the primary colour and a filled badge: the selection is not shown by a tint alone
  cardOn: {
    borderWidth: 2,
    borderColor: color.primary,
    backgroundColor: color.primarySubtle,
    paddingVertical: space[4] - 1,
    paddingHorizontal: space[2] - 1,
  },
});
