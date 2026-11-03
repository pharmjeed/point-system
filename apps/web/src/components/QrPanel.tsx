import { Smartphone, Timer } from 'lucide-react';
import type { ReactNode } from 'react';
import { components } from '@/i18n/ar';
import { useBrand } from '@/hooks/useMe';
import { cx } from '@/lib/cx';
import { Icon } from './Icon';
import { Logo } from './Logo';

export interface QrPanelProps {
  /** SVG markup generated locally with `qrcode` (error correction M, 4-module quiet zone) from the wa.me link. */
  qrSvg: string;
  /** Remaining time, formatted «m:ss» from `expires_at` (link.qr_ttl_min). */
  ttl?: string;
  expired?: boolean;
  /**
   * The 02 D-07 «Meta» line (site · ticket · «صالح لمدة 9:41») in place of the countdown sentence: the site name
   * and the ticket number only — never a staff name, a plate or a phone (02 D-07 «الجزء العلوي لا يعرض…»).
   */
  meta?: ReactNode;
  /** The 02 D-07 «Status» line under it («بانتظار رسالتك…»). */
  status?: ReactNode;
}

/**
 * Customer-facing QR panel (D-07) — the MASAF brand surface inside the staff app (canon §1, 03 §3.13).
 * Always light; the staff brand never appears here.
 */
export function QrPanel({ qrSvg, ttl, expired, meta, status }: QrPanelProps) {
  const brand = useBrand();
  return (
    <div className="pt-qr" data-theme="light" dir="rtl" lang="ar">
      <div className="pt-qr__brand">
        <Logo brand="masaf" variant="wordmark" theme="light" height={40} alt={brand.customerNameAr} />
      </div>
      <h2 className="pt-qr__title">{components.qr.title}</h2>
      <div
        className={cx('pt-qr__code', expired && 'is-expired')}
        role="img"
        aria-label={components.qr.alt}
        dangerouslySetInnerHTML={{ __html: qrSvg }}
      />
      <ol className="pt-qr__steps">
        <li>
          <span className="pt-qr__n">1</span>
          {components.qr.step1}
        </li>
        <li>
          <span className="pt-qr__n">2</span>
          {components.qr.step2}
        </li>
      </ol>
      <p className={cx('pt-qr__ttl', expired && 'is-expired')}>
        <Icon icon={Timer} size={20} />
        {expired ? (
          <span>{components.qr.expired}</span>
        ) : meta ? (
          <span>{meta}</span>
        ) : (
          <span>
            {components.qr.expiresInLabel}{' '}
            <bdi dir="ltr" className="pt-num">
              {ttl}
            </bdi>
          </span>
        )}
      </p>
      {status && !expired ? (
        <p className="pt-qr__status" role="status" aria-live="polite">
          {status}
        </p>
      ) : null}
      <p className="pt-qr__driverhint">
        <Icon icon={Smartphone} size={16} />
        {components.qr.driverHint}
      </p>
    </div>
  );
}
