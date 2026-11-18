/**
 * Entry: waits for the session read, then sends journey R1 where it continues (src/features/onboarding.ts).
 */
import { Redirect, useRouter } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useI18n } from '../i18n/I18nProvider';
import { useSession } from '../session/SessionProvider';
import { color, space } from '../theme/tokens';
import { AppText } from '../ui/AppText';
import { Button } from '../ui/Button';
import { Screen } from '../ui/Screen';

export default function Index() {
  const session = useSession();
  const { t } = useI18n();
  const router = useRouter();
  if (session.phase === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={color.primary} size="large" accessibilityLabel={t.common.loading} />
      </View>
    );
  }
  if (session.phase === 'offline') {
    return (
      <Screen footer={<Button label={t.common.retry} onPress={session.reload} />}>
        <AppText accessibilityRole="alert">{t.common.networkError}</AppText>
        {/* C-11 works without a network once cached (V2-D14): reachable from here too */}
        <Button label={t.home.pass} variant="secondary" onPress={() => router.push('/pass')} />
      </Screen>
    );
  }
  return <Redirect href={session.destination()} />;
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.bg,
    padding: space[4],
  },
});
