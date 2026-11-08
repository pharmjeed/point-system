/**
 * C-17 الفواتير (V2-040, DEC-548): the account's simplified tax invoices — one for every visit paid in the app — and
 * the credit notes of their refunds, newest first (`GET /v1/customer/invoices`). A row opens the invoice.
 */
import type { CustomerInvoiceSummary } from '@point/shared/customer';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { errorText } from '../features/errorText';
import { invoiceRow } from '../features/invoices';
import { useI18n } from '../i18n/I18nProvider';
import { useSession } from '../session/SessionProvider';
import { color, radius, space } from '../theme/tokens';
import { AppText } from '../ui/AppText';
import { Banner, Card } from '../ui/Controls';
import { DevBanner } from '../ui/DevBanner';
import { Screen } from '../ui/Screen';
import { ScreenHeader } from '../ui/ScreenHeader';

export default function Invoices() {
  const { t, locale } = useI18n();
  const session = useSession();
  const router = useRouter();
  const [items, setItems] = useState<CustomerInvoiceSummary[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await session.api.invoices());
      setFailure(null);
    } catch (e) {
      setFailure(`${t.invoices.loadFailed} ${errorText(e, t, locale)}`);
    }
  }, [session.api, t, locale]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <Screen>
      <ScreenHeader title={t.invoices.title} backLabel={t.invoices.back} onBack={() => router.back()} />
      <DevBanner />
      {failure ? <Banner tone="danger">{failure}</Banner> : null}
      {!items && !failure ? (
        <ActivityIndicator color={color.primary} accessibilityLabel={t.common.loading} />
      ) : null}
      {items && items.length === 0 ? (
        <Card>
          <AppText tone="muted">{t.invoices.empty}</AppText>
        </Card>
      ) : null}
      {items?.map((i) => {
        const row = invoiceRow(i, t, locale);
        return (
          <Pressable
            key={row.id}
            accessibilityRole="button"
            accessibilityLabel={`${row.title} ${row.amount}`}
            onPress={() => router.push({ pathname: '/invoice/[invoiceId]', params: { invoiceId: row.id } })}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            testID="invoice-row"
          >
            <View style={styles.head}>
              <AppText variant="bodyStrong">{row.title}</AppText>
              <AppText variant="bodyStrong" tone={row.credit ? 'success' : undefined}>
                {row.amount}
              </AppText>
            </View>
            <AppText variant="small" tone="muted">
              {row.subtitle}
            </AppText>
            <AppText variant="small">{row.status}</AppText>
          </Pressable>
        );
      })}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: {
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.border,
    padding: space[4],
    gap: space[1],
  },
  head: { flexDirection: 'row', justifyContent: 'space-between', gap: space[2] },
  pressed: { backgroundColor: color.primarySubtle },
});
