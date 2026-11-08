import { CircleAlert, CircleCheck, Hourglass, Scale } from 'lucide-react';
import type { SettlementLine, SettlementStatement, SettlementStatus, ZatcaStatus } from '@/api/billing';
import { StateChip } from '@/features/common/StateChip';
import {
  invoiceKind,
  o05,
  settlementBreakdown,
  settlementLineKind,
  settlementStatus,
  zatcaStatus,
} from '@/i18n/ar.staff';
import { fmt } from '@/i18n/fmt';
import { formatHalalas } from '@/lib/format';
import { SETTLEMENT_TONE, ZATCA_TONE, breakdown, netDirection } from './billingModel';

/** Shared pieces of P-09 / P-10 (platform) and O-05 / O-06 (operator): chips, the breakdown and the lines. */

export function SettlementChip({ status }: { status: SettlementStatus }) {
  return (
    <StateChip
      label={settlementStatus[status]}
      tone={SETTLEMENT_TONE[status]}
      icon={status === 'paid' ? CircleCheck : status === 'disputed' ? CircleAlert : Scale}
    />
  );
}

export function ZatcaChip({ status }: { status: ZatcaStatus }) {
  return (
    <StateChip
      label={zatcaStatus[status]}
      tone={ZATCA_TONE[status]}
      icon={status === 'pending' ? Hourglass : status === 'rejected' ? CircleAlert : CircleCheck}
    />
  );
}

export const kindLabel = (k: keyof typeof invoiceKind) => invoiceKind[k];

export function Money({ halalas, strong }: { halalas: number; strong?: boolean }) {
  return (
    <bdi dir="ltr" className={`pt-num whitespace-nowrap${strong ? ' font-bold' : ''}`}>
      {formatHalalas(halalas)}
    </bdi>
  );
}

/** The statement as signed rows adding up to the net, and who pays whom. */
export function StatementBreakdown({ statement: s }: { statement: SettlementStatement }) {
  const direction = netDirection(s.net_payable_halalas);
  return (
    <dl className="pt-kv" data-testid="settlement-breakdown">
      {breakdown(s).map((r) => (
        <div key={r.key} className="contents">
          <dt>
            {r.count !== undefined
              ? fmt(settlementBreakdown[r.key], { n: String(r.count) })
              : settlementBreakdown[r.key]}
          </dt>
          <dd>
            <Money halalas={r.halalas} />
          </dd>
        </div>
      ))}
      <dt className="font-bold">{settlementBreakdown.net}</dt>
      <dd>
        <Money halalas={s.net_payable_halalas} strong />
        <span className="block text-sm text-text-muted">
          {direction === 'point_pays'
            ? settlementBreakdown.pointPays
            : direction === 'operator_pays'
              ? settlementBreakdown.operatorPays
              : settlementBreakdown.nothing}
        </span>
      </dd>
    </dl>
  );
}

/** The lines of a statement: kind, day, venue / ticket, amount (signed), the adjustment's reason. */
export function LinesList({ lines }: { lines: SettlementLine[] }) {
  return (
    <ul className="st-stack" data-testid="settlement-lines">
      {lines.map((l) => (
        <li key={l.id} className={l.released_at ? 'opacity-60' : undefined}>
          <span>
            <span className="font-bold">{settlementLineKind[l.kind]}</span>
            <span className="block text-sm text-text-muted">
              {[
                l.occurred_on,
                l.venue?.name_ar,
                l.ticket?.display_number ? fmt(o05.ticket, { n: String(l.ticket.display_number) }) : null,
                l.rate_bp ? `${(l.rate_bp / 100).toFixed(2)}%` : null,
                l.quantity_days ? fmt(o05.days, { n: String(l.quantity_days) }) : null,
                l.note,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </span>
          <Money halalas={l.amount_halalas} />
        </li>
      ))}
    </ul>
  );
}
