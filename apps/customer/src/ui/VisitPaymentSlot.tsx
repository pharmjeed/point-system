/**
 * The money area of C-12 (docs/v2/01 R4). V2-015 shows the visit's payment summary line; V2-022 / V2-023 (DEC-521 …
 * DEC-525) add here, without touching C-12, the «ادفع X ريال» card and its sheet (`features/pay`: saved cards, a card
 * tokenized on the device with the publishable key, «حفظ البطاقة», Apple Pay where a native provider exists) while
 * the server says the visit is payable in the app (`payment.payable_in_app`). The request is never blocked before
 * payment (R4); once paid the server's `visit.updated` makes C-12 read the visit again («مدفوع في التطبيق»).
 */
import type { CustomerVisitDetail } from '@point/shared/customer';
import { PayDue, type ApplePayProvider } from '../features/pay';
import { paymentLine } from '../features/visit';
import { useI18n } from '../i18n/I18nProvider';
import { AppText } from './AppText';
import { Card } from './Controls';

export function VisitPaymentSlot({
  visit,
  onPaid,
  applePay,
}: {
  visit: CustomerVisitDetail;
  /** re-read the visit right away (the realtime update follows anyway) */
  onPaid?: () => void;
  applePay?: ApplePayProvider;
}) {
  const { t } = useI18n();
  const line = paymentLine(visit.payment, t);
  const payable = visit.payment.payable_in_app;
  if (!line && !payable) return null;
  return (
    <>
      {line ? (
        <Card>
          <AppText variant="label">{t.visit.payment.title}</AppText>
          <AppText>{line}</AppText>
        </Card>
      ) : null}
      {payable ? (
        <PayDue
          ticketId={visit.ticket_id}
          amountHalalas={visit.payment.fee_halalas}
          {...(onPaid ? { onPaid } : {})}
          {...(applePay ? { applePay } : {})}
        />
      ) : null}
    </>
  );
}
