import {
  BellOff,
  CircleAlert,
  Coffee,
  Info,
  LoaderCircle,
  MessageCircle,
  RefreshCw,
  VolumeX,
  Wifi,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { components, d15, ui } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { cx } from '@/lib/cx';
import { useBrand } from '@/hooks/useMe';
import { Icon } from './Icon';

export type BannerKind =
  'offline' | 'stale' | 'audio' | 'whatsapp' | 'notifications' | 'update' | 'break' | 'error' | 'info';

const KINDS: Record<BannerKind, { tone: 'danger' | 'warning' | 'info'; icon: LucideIcon }> = {
  offline: { tone: 'danger', icon: WifiOff },
  stale: { tone: 'warning', icon: Wifi },
  audio: { tone: 'warning', icon: VolumeX },
  whatsapp: { tone: 'danger', icon: MessageCircle },
  notifications: { tone: 'warning', icon: BellOff },
  update: { tone: 'info', icon: RefreshCw },
  break: { tone: 'warning', icon: Coffee },
  error: { tone: 'danger', icon: CircleAlert },
  info: { tone: 'info', icon: Info },
};

export interface BannerProps {
  kind: BannerKind;
  /** Defaults to the D-15 text for the kind when it has one. */
  message?: ReactNode;
  /** Second line (e.g. «رمز المتابعة: …» or the D-15 offline detail). */
  detail?: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  loading?: boolean;
  /** Inside a card/form instead of a full-width strip under the TopBar. */
  rounded?: boolean;
}

/**
 * Persistent strip under the TopBar until the cause is gone (03 §3.14, 02 D-15): icon + semantic colour +
 * one action. Danger banners announce assertively (`role="alert"`), the others politely.
 */
export function Banner({ kind, message, detail, actionLabel, onAction, loading, rounded }: BannerProps) {
  const brand = useBrand();
  const { tone, icon } = KINDS[kind];
  const defaults: Partial<Record<BannerKind, string>> = {
    stale: ui.syncing,
    audio: d15.audio,
    whatsapp: d15.whatsappDown,
    notifications: fmt(d15.notificationsDenied, { brand: brand.staffNameAr }),
    update: fmt(d15.update, { brand: brand.staffNameAr }),
  };
  const actionDefaults: Partial<Record<BannerKind, string>> = {
    update: d15.updateNow,
    audio: components.banner.enableAudio,
  };
  const label = actionLabel ?? actionDefaults[kind];
  return (
    <div
      className={cx('pt-banner', `pt-banner--${tone}`, rounded && 'pt-banner--rounded')}
      role={tone === 'danger' ? 'alert' : 'status'}
      data-kind={kind}
    >
      <Icon icon={icon} />
      <span className="pt-banner__text">
        {message ?? defaults[kind]}
        {detail ? <span className="pt-banner__detail">{detail}</span> : null}
      </span>
      {onAction && label ? (
        <button
          type="button"
          className="pt-banner__action"
          disabled={loading}
          onClick={onAction}
          aria-busy={loading || undefined}
        >
          {loading ? <Icon icon={LoaderCircle} size={16} spin /> : null}
          {loading ? components.loadingLabel : label}
        </button>
      ) : null}
    </div>
  );
}
