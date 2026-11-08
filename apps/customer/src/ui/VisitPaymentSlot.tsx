/**
 * The money area of C-12 (docs/v2/01 R4). V2-015 shows the visit's payment summary line only; the «ادفع» card and
 * button (pay per visit in the app, saved cards — V2-022 / V2-023, `POST /v1/customer/visits/{ticketId}/pay`) belong
 * to the payments stream and plug in HERE, without touching C-12: this component receives the whole visit and owns
 * everything about paying for it. The request is never blocked before payment (R4).
 */
import type { CustomerVisitDetail } from '@point/shared/customer';
import { paymentLine } from '../features/visit';
import { useI18n } from '../i18n/I18nProvider';
import { AppText } from './AppText';
import { Card } from './Controls';

export function VisitPaymentSlot({ visit }: { visit: CustomerVisitDetail }) {
  const { t } = useI18n();
  const line = paymentLine(visit.payment, t);
  if (!line) return null;
  return (
    <Card>
      <AppText variant="label">{t.visit.payment.title}</AppText>
      <AppText>{line}</AppText>
      {/* V2-022: the «ادفع» action of a due fee goes here (payments stream) */}
    </Card>
  );
}
