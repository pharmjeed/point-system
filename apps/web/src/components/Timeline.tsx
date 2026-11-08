import { CarFront, CircleX, KeyRound, MessageCircle, type LucideIcon } from 'lucide-react';
import { components } from '@/i18n/ar';
import { useBrand } from '@/hooks/useMe';
import { cx } from '@/lib/cx';
import { Icon } from './Icon';
import { Logo } from './Logo';

export interface TimelineEvent {
  kind?: 'ticket' | 'custody' | 'whatsapp';
  text: string;
  actor: string;
  time: string;
  /** Customer message preview (codes masked «••••••»). */
  message?: string;
  failed?: boolean;
  icon?: LucideIcon;
}

const KIND_ICON: Record<NonNullable<TimelineEvent['kind']>, LucideIcon> = {
  ticket: CarFront,
  custody: KeyRound,
  whatsapp: MessageCircle,
};

/**
 * Ticket history (S-03): ticket events, custody events and WhatsApp messages in time order. A customer
 * message preview carries the customer brand — one of the surfaces canon §1 allows.
 */
export function Timeline({ events }: { events: TimelineEvent[] }) {
  const brand = useBrand();
  return (
    <ol className="pt-timeline">
      {events.map((e, i) => {
        const kind = e.kind ?? 'ticket';
        return (
          <li key={`${e.time}-${i}`} className={cx('pt-tl', `pt-tl--${kind}`, e.failed && 'is-failed')}>
            <span className="pt-tl__icon">
              <Icon icon={e.icon ?? KIND_ICON[kind]} size={16} />
            </span>
            <div className="pt-tl__body">
              <div className="pt-tl__row">
                <span className="pt-tl__text">{e.text}</span>
                <bdi dir="ltr" className="pt-tl__time">
                  {e.time}
                </bdi>
              </div>
              <span className="pt-tl__actor">{e.actor}</span>
              {e.message ? (
                <div className="pt-tl__msg">
                  <span className="pt-tl__brand">
                    <Logo brand="masaf" variant="avatar" height={20} alt="" />
                    {brand.customerNameAr}
                  </span>
                  <p>{e.message}</p>
                  {e.failed ? (
                    <span className="pt-tl__fail">
                      <Icon icon={CircleX} size={16} />
                      {components.timeline.failed}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
