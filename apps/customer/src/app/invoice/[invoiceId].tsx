/**
 * C-17 فاتورة (V2-040, DEC-548): one simplified tax invoice or credit note of the account — POINT as the seller with
 * its VAT and CR numbers, the lines with the VAT apart, the totals, the ZATCA QR (scannable by any e-invoice reader)
 * and «تنزيل الفاتورة PDF» (a private link of a few minutes, read again on each press; the server says when the file
 * is still being prepared).
 */
import type { CustomerInvoiceDetail } from '@point/shared/customer';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import QRCode from 'qrcode';
import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { errorText } from '../../features/errorText';
import { invoiceDetail } from '../../features/invoices';
import { qrRuns } from '../../features/pass';
import { useI18n } from '../../i18n/I18nProvider';
import { useSession } from '../../session/SessionProvider';
import { color, radius, space } from '../../theme/tokens';
import { AppText } from '../../ui/AppText';
import { Button } from '../../ui/Button';
import { Banner, Card } from '../../ui/Controls';
import { DevBanner } from '../../ui/DevBanner';
import { openLink } from '../../ui/openLinks';
import { Screen } from '../../ui/Screen';
import { SkeletonList } from '../../ui/Skeleton';
import { ScreenHeader } from '../../ui/ScreenHeader';

const QR_SIZE = 200;

export default function Invoice() {
  const { t, locale } = useI18n();
  const session = useSession();
  const router = useRouter();
  const { invoiceId } = useLocalSearchParams<{ invoiceId: string }>();
  const [doc, setDoc] = useState<CustomerInvoiceDetail | null>(null);
  const [message, setMessage] = useState<{ tone: 'danger' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await session.api.invoice(invoiceId);
      setDoc(d);
      return d;
    } catch (e) {
      setMessage({ tone: 'danger', text: `${t.invoices.loadFailed} ${errorText(e, t, locale)}` });
      return null;
    }
  }, [session.api, invoiceId, t, locale]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const view = doc ? invoiceDetail(doc, t, locale) : null;
  const runs = useMemo(
    () => (view ? qrRuns(QRCode.create(view.qr, { errorCorrectionLevel: 'M' }).modules) : null),
    [view?.qr],
  );

  async function download() {
    setBusy(true);
    try {
      // the link lives a few minutes: read the invoice again to get a fresh one
      const fresh = await load();
      if (!fresh?.pdf_url) return setMessage({ tone: 'info', text: t.invoices.pdfPending });
      if (!(await openLink(fresh.pdf_url))) setMessage({ tone: 'danger', text: t.invoices.openFailed });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <ScreenHeader title={t.invoices.title} backLabel={t.invoices.back} onBack={() => router.back()} />
      <DevBanner />
      {message ? <Banner tone={message.tone}>{message.text}</Banner> : null}
      {!view ? (
        <SkeletonList label={t.common.loading} hero count={1} />
      ) : (
        <>
          <Card>
            <AppText variant="bodyStrong">{view.heading}</AppText>
            <Fact label={t.invoices.number} value={view.number} />
            <Fact label={t.invoices.issued} value={view.issued} />
            <AppText variant="small" tone="muted">
              {view.status}
            </AppText>
            {view.original ? <Fact label={t.invoices.original} value={view.original} /> : null}
            {view.reason ? <Fact label={t.invoices.reason} value={view.reason} /> : null}
          </Card>
          <Card>
            <AppText variant="bodyStrong">{t.invoices.seller}</AppText>
            <AppText>{view.seller.name}</AppText>
            <Fact label={t.invoices.vatNumber} value={view.seller.vatNumber} />
            <Fact label={t.invoices.crNumber} value={view.seller.crNumber} />
            <AppText variant="small" tone="muted">
              {view.seller.address}
            </AppText>
          </Card>
          <Card>
            {view.lines.map((l, i) => (
              <View key={i} style={styles.line}>
                <AppText>{l.description}</AppText>
                <AppText variant="bodyStrong">{l.total}</AppText>
              </View>
            ))}
            <Fact label={t.invoices.subtotal} value={view.subtotal} />
            <Fact label={view.vatLabel} value={view.vat} />
            <Fact label={t.invoices.total} value={view.total} strong />
          </Card>
          <View
            style={styles.qr}
            accessible
            accessibilityRole="image"
            accessibilityLabel={t.invoices.qrLabel}
            testID="invoice-qr"
          >
            {runs?.map((row, y) => {
              const c = Math.floor((QR_SIZE - space[4] * 2) / runs.length);
              return (
                <View key={y} style={[styles.row, { height: c }]}>
                  {row.map(([x, n]) => (
                    <View key={x} style={[styles.dark, { left: x * c, width: n * c, height: c }]} />
                  ))}
                </View>
              );
            })}
          </View>
          <Button
            label={t.invoices.pdf}
            variant="secondary"
            loading={busy}
            loadingLabel={t.common.loading}
            onPress={() => void download()}
            testID="invoice-pdf"
          />
        </>
      )}
    </Screen>
  );
}

function Fact({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.line}>
      <AppText variant="small" tone="muted">
        {label}
      </AppText>
      <AppText variant={strong ? 'bodyStrong' : 'body'}>{value}</AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: 'row', justifyContent: 'space-between', gap: space[2], flexWrap: 'wrap' },
  qr: {
    alignSelf: 'center',
    width: QR_SIZE,
    height: QR_SIZE,
    padding: space[4],
    backgroundColor: color.surface,
    borderRadius: radius.md,
    // the code is never mirrored in RTL
    direction: 'ltr',
  },
  row: { position: 'relative' },
  dark: { position: 'absolute', top: 0, backgroundColor: color.text },
});
