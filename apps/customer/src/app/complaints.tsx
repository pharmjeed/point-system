/**
 * C-21 «الشكاوى» (V2-037; docs/v2/01 C-21; DEC-603; the subscriptions annex clauses 5 and 6 «تسجل الشكاوى برقم
 * مرجعي»): the account's complaints, newest first — each with its reference number, type, date, status and the
 * platform's reply — and «شكوى جديدة» (C-22). Read again on focus.
 */
import type { CustomerComplaint } from '@point/shared/customer';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { complaintCard } from '../features/annex';
import { errorText } from '../features/errorText';
import { fmt } from '../i18n';
import { useI18n } from '../i18n/I18nProvider';
import { useSession } from '../session/SessionProvider';
import { space } from '../theme/tokens';
import { AppText } from '../ui/AppText';
import { Button } from '../ui/Button';
import { Banner, Card } from '../ui/Controls';
import { DevBanner } from '../ui/DevBanner';
import { EmptyState } from '../ui/EmptyState';
import { Screen } from '../ui/Screen';
import { ScreenHeader } from '../ui/ScreenHeader';
import { SkeletonList } from '../ui/Skeleton';

const TONE = { success: 'success', warning: 'primary', muted: 'muted' } as const;

export default function Complaints() {
  const params = useLocalSearchParams<{ sent?: string }>();
  const { t, locale } = useI18n();
  const session = useSession();
  const router = useRouter();
  const [items, setItems] = useState<CustomerComplaint[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      session.api.complaints().then(setItems, (e) => setFailure(errorText(e, t, locale)));
    }, [session.api, t, locale]),
  );

  return (
    <Screen
      footer={
        <Button
          label={t.annex.newComplaint}
          icon="plus"
          onPress={() => router.push('/complaint-new')}
          testID="complaint-new"
        />
      }
    >
      <ScreenHeader title={t.annex.complaintsTitle} backLabel={t.common.back} onBack={() => router.back()} />
      <DevBanner />
      {params.sent ? (
        <Banner tone="success">{fmt(t.annex.complaintSent, { reference: params.sent })}</Banner>
      ) : null}
      {failure ? <Banner tone="danger">{failure}</Banner> : null}
      <AppText variant="small" tone="muted">
        {t.annex.complaintsHint}
      </AppText>
      {!items && !failure ? <SkeletonList label={t.common.loading} count={2} /> : null}
      {items && items.length === 0 ? (
        <EmptyState icon="message-warning" text={t.annex.complaintsEmpty} />
      ) : null}
      {items?.map((c) => {
        const card = complaintCard(c, t);
        return (
          <Card key={c.complaint_id}>
            <View style={styles.head}>
              <AppText variant="cardTitle" style={styles.flex}>
                {card.title}
              </AppText>
              <AppText variant="bodyStrong" tone={TONE[card.tone]}>
                {card.status}
              </AppText>
            </View>
            <AppText variant="small">{card.reference}</AppText>
            <AppText variant="small" tone="muted">
              {card.date}
              {c.venue_name_ar
                ? ` · ${locale === 'en' && c.venue_name_en ? c.venue_name_en : c.venue_name_ar}`
                : ''}
            </AppText>
            <AppText>{c.body}</AppText>
            {card.note ? (
              <AppText variant="small" tone="primary">
                {card.note}
              </AppText>
            ) : null}
          </Card>
        );
      })}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  head: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
});
