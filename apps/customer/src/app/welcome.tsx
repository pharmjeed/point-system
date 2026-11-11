/**
 * C-01 الترحيب: three cards, «ابدأ» and «لدي حساب» (both lead to C-02: one sign-in for new and returning
 * customers, V2-D11). Shown once per install.
 *
 * V2-UX (DEC-576): the brand logo on a white panel, then the three promises as cards with their own
 * icon (car, phone, saving) entering one after the other; «ابدأ» in the sticky bottom sheet.
 */
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useI18n } from '../i18n/I18nProvider';
import { useSession } from '../session/SessionProvider';
import { color, radius, shadow, space } from '../theme/tokens';
import { FadeIn } from '../ui/Animated';
import { AppText } from '../ui/AppText';
import { Button } from '../ui/Button';
import { IconBadge } from '../ui/Controls';
import type { IconName } from '../ui/Icon';
import { Logo } from '../ui/Logo';
import { Screen } from '../ui/Screen';

/** One icon per promise of C-01, in the order of `t.welcome.cards`. */
const CARD_ICONS: readonly IconName[] = ['car-front', 'smartphone', 'badge-percent'];

export default function Welcome() {
  const { t, f, brand } = useI18n();
  const session = useSession();
  const router = useRouter();

  const go = async () => {
    await session.markWelcomeSeen();
    router.replace('/phone');
  };

  return (
    <Screen
      footer={
        <>
          <Button label={t.welcome.start} icon="go" onPress={go} testID="welcome-start" />
          <Button label={t.welcome.haveAccount} variant="ghost" size="md" onPress={go} />
        </>
      }
    >
      <View style={styles.hero}>
        <Logo variant="stacked" height={132} label={brand} />
        <AppText variant="title" center accessibilityRole="header">
          {f(t.welcome.title)}
        </AppText>
      </View>
      {t.welcome.cards.map((card, i) => (
        <FadeIn key={card.title} index={i + 1}>
          <View style={styles.card}>
            <IconBadge name={CARD_ICONS[i] ?? 'circle-check'} size={52} />
            <View style={styles.flex}>
              <AppText variant="cardTitle">{card.title}</AppText>
              <AppText tone="muted">{card.body}</AppText>
            </View>
          </View>
        </FadeIn>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: {
    alignItems: 'center',
    gap: space[4],
    paddingVertical: space[6],
    marginBottom: space[2],
    borderRadius: radius.xl,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    boxShadow: shadow.sm,
  },
  card: {
    flexDirection: 'row',
    gap: space[4],
    alignItems: 'center',
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.border,
    padding: space[4],
    boxShadow: shadow.sm,
  },
  flex: { flex: 1, gap: space[1] },
});
