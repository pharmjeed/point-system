import type { LucideIcon } from 'lucide-react';
import { cx } from '@/lib/cx';
import { Icon } from './Icon';

export interface KpiTileProps {
  label: string;
  value?: string | number;
  icon?: LucideIcon;
  /** Changes the border and text colour, not the background (design system). */
  tone?: 'warning' | 'danger' | 'success';
  meta?: string;
  loading?: boolean;
}

/** One indicator: label with icon, large Mono value, small meta (03 §3.16). */
export function KpiTile({ label, value, icon, tone, meta, loading }: KpiTileProps) {
  return (
    <div className={cx('pt-kpi', tone && `pt-kpi--${tone}`)} aria-busy={loading || undefined}>
      <span className="pt-kpi__label">
        {icon ? <Icon icon={icon} size={16} /> : null}
        {label}
      </span>
      {loading ? (
        <span className="pt-skel pt-skel--kpi" />
      ) : (
        <span className="pt-kpi__value">
          <bdi dir="ltr">{value}</bdi>
        </span>
      )}
      {meta ? <span className="pt-kpi__meta">{meta}</span> : null}
    </div>
  );
}

export interface KpiStripProps {
  items: KpiTileProps[];
  loading?: boolean;
}

/** S-02 indicator strip: open requests, oldest wait, drivers available/busy, failed messages, critical alerts. */
export function KpiStrip({ items, loading }: KpiStripProps) {
  return (
    <div className="pt-kpistrip" role="list">
      {items.map((item) => (
        <div role="listitem" key={item.label}>
          <KpiTile loading={loading} {...item} />
        </div>
      ))}
    </div>
  );
}
