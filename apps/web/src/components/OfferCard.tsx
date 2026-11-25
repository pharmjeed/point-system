import { BellRing, Info } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useServerNow } from '@/hooks/useNow';
import { components } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { cx } from '@/lib/cx';
import { formatClock } from '@/lib/format';
import { Button } from './Button';
import { CountdownRing } from './CountdownRing';
import { Icon } from './Icon';
import { PlateBadge, type PlateValue } from './PlateBadge';
import { TicketNumber } from './TicketNumber';
import { CarGlyph, type CarValue } from './CarGlyph';

export interface OfferCardProps {
  offerId: string;
  mode: 'single' | 'broadcast';
  ticketNumber: number;
  vehicleSummary: string;
  plate?: PlateValue;
  /** DEC-642: the car drawn in its type and colour */
  car?: CarValue;
  venue?: string;
  /** ISO; «ينتظر منذ…» is computed from it and the server clock. */
  requestedAt: string;
  /** ISO; the ring is shown for single offers only. */
  expiresAt?: string;
  totalSeconds?: number;
  /** From `eligible_as` / `can_accept` / `can_reserve_next` (03 §3.5). */
  canAcceptAs: 'accept' | 'reserve_next' | 'none';
  onAccept?: () => Promise<unknown>;
  loading?: boolean;
  error?: string;
  /** Accept/handover need a confirmed connection (03 §4.4): offline or uncertain. */
  offline?: boolean;
  /** The disabled button's text then (02 D-09 «لا يمكن القبول دون اتصال»; default the 03 §4.4 text). */
  offlineText?: string;
  /** The data is being synced (02 §1.6): the button waits, with its own label. */
  waiting?: boolean;
  /** The reminder came (02 D-09): warning ring and the reminder line. */
  reminded?: boolean;
  /** Text of the reminder line (14 §5.1). */
  reminderText?: string;
  /** «انتهى العرض» (02 D-09) shown when a single offer reaches zero. */
  expiredText?: string;
  /** Called once when a single offer reaches zero (the card leaves a second later, 02 D-09). */
  onExpire?: () => void;
}

/**
 * What the card's live region says (02 §7 item 9: the countdown is not announced every second; the card is
 * announced on arrival, at the reminder and at the end): set after mount, so the region exists before its
 * text changes, and changed only on those transitions.
 */
function useAnnouncement(arrival: string, reminder: string | null, expired: string | null): string {
  const [said, setSaid] = useState('');
  useEffect(() => {
    setSaid(expired ?? reminder ?? arrival);
  }, [arrival, reminder, expired]);
  return said;
}

/**
 * Retrieval request card (D-09): only the oldest actionable request is shown. The server decides; the
 * card never shows «تم القبول» before the reply. A visually hidden assertive region announces the new offer
 * («طلب إحضار جديد، تذكرة 125»), the reminder and the end — never the ticking clock, which stays outside any
 * live region. The countdown runs on server time (`expires_at` − server now, 02 §1.7); at zero the card says
 * «انتهى العرض» and its button stops.
 */
export function OfferCard({
  mode,
  ticketNumber,
  vehicleSummary,
  plate,
  car,
  venue,
  requestedAt,
  expiresAt,
  totalSeconds = 30,
  canAcceptAs,
  onAccept,
  loading,
  error,
  offline,
  offlineText,
  waiting,
  reminded,
  reminderText,
  expiredText,
  onExpire,
}: OfferCardProps) {
  const now = useServerNow(1000);
  const waitingSeconds = (now - Date.parse(requestedAt)) / 1000;
  const secondsLeft = expiresAt ? Math.max(0, (Date.parse(expiresAt) - now) / 1000) : undefined;
  const expired = mode === 'single' && secondsLeft !== undefined && secondsLeft <= 0;
  const expireSent = useRef(false);
  useEffect(() => {
    if (expired && !expireSent.current) {
      expireSent.current = true;
      onExpire?.();
    }
  }, [expired, onExpire]);
  const announcement = fmt(components.offer.announce, { n: ticketNumber });
  const said = useAnnouncement(
    announcement,
    reminded && reminderText ? reminderText : null,
    expired ? (expiredText ?? null) : null,
  );

  let action: ReactNode;
  if (offline && canAcceptAs !== 'none') {
    action = (
      <Button variant={canAcceptAs === 'reserve_next' ? 'reserve' : 'primary'} size="lg" disabled>
        {offlineText ?? components.offer.requiresConnection}
      </Button>
    );
  } else if (canAcceptAs === 'accept') {
    action = (
      <Button
        variant="primary"
        size="lg"
        loading={loading}
        error={error}
        disabled={waiting || expired}
        onClick={onAccept}
      >
        {components.offer.accept}
      </Button>
    );
  } else if (canAcceptAs === 'reserve_next') {
    action = (
      <>
        <p className="pt-offer__note">{components.offer.reserveNote}</p>
        <Button
          variant="reserve"
          size="lg"
          loading={loading}
          error={error}
          disabled={waiting || expired}
          onClick={onAccept}
        >
          {components.offer.reserve}
        </Button>
      </>
    );
  } else {
    action = (
      <p className="pt-offer__viewonly">
        <Icon icon={Info} size={20} />
        <span>{components.offer.viewOnly}</span>
      </p>
    );
  }

  return (
    <section
      className={cx(
        'pt-offer',
        canAcceptAs === 'reserve_next' && 'pt-offer--reserve',
        reminded && 'pt-offer--reminded',
      )}
      aria-label={announcement}
      data-offer-state={expired ? 'expired' : reminded ? 'reminded' : 'live'}
    >
      <p className="pt-sr" aria-live="assertive" aria-atomic="true" data-offer-announce>
        {said}
      </p>
      <div className="pt-offer__head">
        <div className="pt-offer__id">
          <span className="pt-offer__title">
            {expired && expiredText
              ? expiredText
              : mode === 'single'
                ? components.offer.single
                : components.offer.broadcast}
          </span>
          <TicketNumber n={ticketNumber} size="display" />
        </div>
        {mode === 'single' && secondsLeft !== undefined ? (
          <CountdownRing seconds={secondsLeft} total={totalSeconds} warn={reminded} />
        ) : null}
      </div>
      <div className="pt-offer__vehicle">
        {car ? <CarGlyph {...car} width={64} /> : null}
        <span>{vehicleSummary}</span>
        {plate ? <PlateBadge {...plate} /> : null}
      </div>
      <p className="pt-offer__meta">
        {venue ? `${venue} · ` : ''}
        {components.offer.waitingSinceLabel}{' '}
        <bdi dir="ltr" className="pt-num">
          {formatClock(waitingSeconds)}
        </bdi>
      </p>
      {reminded && reminderText && !expired ? (
        <p className="pt-offer__reminder">
          <Icon icon={BellRing} size={16} />
          <span>{reminderText}</span>
        </p>
      ) : null}
      {action}
    </section>
  );
}
