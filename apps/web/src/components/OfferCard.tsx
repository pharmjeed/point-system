import { Info } from 'lucide-react';
import type { ReactNode } from 'react';
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

export interface OfferCardProps {
  offerId: string;
  mode: 'single' | 'broadcast';
  ticketNumber: number;
  vehicleSummary: string;
  plate?: PlateValue;
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
  /** Accept/handover need a confirmed connection (03 §4.4). */
  offline?: boolean;
}

/**
 * Retrieval request card (D-09): only the oldest actionable request is shown. The server decides; the
 * card never shows «تم القبول» before the reply. aria-live assertive announces a new offer.
 */
export function OfferCard({
  mode,
  ticketNumber,
  vehicleSummary,
  plate,
  venue,
  requestedAt,
  expiresAt,
  totalSeconds = 30,
  canAcceptAs,
  onAccept,
  loading,
  error,
  offline,
}: OfferCardProps) {
  const now = useServerNow(1000);
  const waitingSeconds = (now - Date.parse(requestedAt)) / 1000;
  const secondsLeft = expiresAt ? Math.max(0, (Date.parse(expiresAt) - now) / 1000) : undefined;

  let action: ReactNode;
  if (offline && canAcceptAs !== 'none') {
    action = (
      <Button variant={canAcceptAs === 'reserve_next' ? 'reserve' : 'primary'} size="lg" disabled>
        {components.offer.requiresConnection}
      </Button>
    );
  } else if (canAcceptAs === 'accept') {
    action = (
      <Button variant="primary" size="lg" loading={loading} error={error} onClick={onAccept}>
        {components.offer.accept}
      </Button>
    );
  } else if (canAcceptAs === 'reserve_next') {
    action = (
      <>
        <p className="pt-offer__note">{components.offer.reserveNote}</p>
        <Button variant="reserve" size="lg" loading={loading} error={error} onClick={onAccept}>
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
      className={cx('pt-offer', canAcceptAs === 'reserve_next' && 'pt-offer--reserve')}
      aria-live="assertive"
      aria-label={fmt(components.offer.announce, { n: ticketNumber })}
    >
      <div className="pt-offer__head">
        <div className="pt-offer__id">
          <span className="pt-offer__title">
            {mode === 'single' ? components.offer.single : components.offer.broadcast}
          </span>
          <TicketNumber n={ticketNumber} size="display" />
        </div>
        {mode === 'single' && secondsLeft !== undefined ? (
          <CountdownRing seconds={secondsLeft} total={totalSeconds} />
        ) : null}
      </div>
      <div className="pt-offer__vehicle">
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
      {action}
    </section>
  );
}
