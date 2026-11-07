/**
 * C-01 الترحيب: three cards, «ابدأ» and «لدي حساب» (both lead to C-02: one sign-in for new and returning
 * customers, V2-D11). Shown once per install.
 */
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useI18n } from '../i18n/I18nProvider';
import { useSession } from '../session/SessionProvider';
import { color, radius, space } from '../theme/tokens';
import { AppText } from '../ui/AppText';
import { Button } from '../ui/Button';
import { Card } from '../ui/Controls';
import { Logo } from '../ui/Logo';
import { Screen } from '../ui/Screen';

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
          <Button label={t.welcome.start} onPress={go} testID="welcome-start" />
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
        <Card key={card.title}>
          <View style={styles.cardRow}>
            <View style={styles.badge}>
              <AppText variant="bodyStrong" tone="primary">
                {String(i + 1)}
              </AppText>
            </View>
            <View style={styles.flex}>
              <AppText variant="cardTitle">{card.title}</AppText>
              <AppText tone="muted">{card.body}</AppText>
            </View>
          </View>
        </Card>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', gap: space[4], paddingVertical: space[6] },
  cardRow: { flexDirection: 'row', gap: space[3], alignItems: 'flex-start' },
  badge: {
    width: 36,
    height: 36,
    borderRadius: radius.full,
    backgroundColor: color.primarySubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  flex: { flex: 1, gap: space[1] },
});
