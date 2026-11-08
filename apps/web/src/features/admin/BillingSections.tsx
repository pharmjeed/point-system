import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ArrowRight, FileText, Scale } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { billingApi, billingKeys, type SettlementDetail } from '@/api/billing';
import type { Me } from '@/api/types';
import { Button, Card, DataTable, EmptyState } from '@/components';
import { operatorCanDispute } from '@/features/platform/billingModel';
import {
  LinesList,
  Money,
  SettlementChip,
  StatementBreakdown,
  ZatcaChip,
} from '@/features/platform/billingUi';
import { PageSkeleton, QueryError, ReasonDialog, Section } from '@/features/supervisor/ui';
import { useStaffCommand } from '@/features/supervisor/useStaffCommand';
import { useOnline } from '@/hooks/useOnline';
import { invoiceKind, o05, o06, p09, p10 } from '@/i18n/ar.staff';
import { fmt } from '@/i18n/fmt';
import { formatDateTime, formatHalalas } from '@/lib/format';

/**
 * O-05 «كشف التسوية» (V2-041; DEC-547): the owner and the administration (`settlement.read`) read their organization's
 * monthly statements with POINT — never a draft — with every line, and dispute an issued one with a reason
 * (`settlement.dispute`). The server reads the organization from the session: nothing of another operator is named.
 */
export function SettlementsSection({ me }: { me: Me }) {
  const [search, setSearch] = useSearchParams();
  const selected = search.get('statement');
  const list = useInfiniteQuery({
    queryKey: billingKeys.operatorStatements,
    queryFn: ({ pageParam, signal }) => billingApi.operatorStatements(pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  if (selected)
    return <StatementView id={selected} me={me} onBack={() => setSearch({}, { replace: true })} />;
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="st-stack" data-testid="operator-settlements">
      <p className="text-sm text-text-muted">{o05.intro}</p>
      {list.isError && !list.data ? (
        <QueryError error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data && !rows.length ? (
        <EmptyState icon={Scale} title={o05.empty} />
      ) : (
        <DataTable
          layout="auto"
          loading={list.isPending}
          rows={rows}
          rowKey={(s) => s.id}
          hasNext={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onNext={() => void list.fetchNextPage()}
          columns={[
            {
              key: 'period',
              label: p09.period,
              render: (s) => (
                <bdi dir="ltr" className="pt-num font-bold">
                  {s.period}
                </bdi>
              ),
            },
            { key: 'status', label: p09.status, render: (s) => <SettlementChip status={s.status} /> },
            { key: 'net', label: p09.net, render: (s) => <Money halalas={s.net_payable_halalas} strong /> },
            {
              key: 'open',
              label: o05.open,
              render: (s) => (
                <Button variant="secondary" compact onClick={() => setSearch({ statement: s.id })}>
                  {o05.open}
                </Button>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}

function StatementView({ id, me, onBack }: { id: string; me: Me; onBack: () => void }) {
  const detail = useQuery({
    queryKey: billingKeys.operatorStatement(id),
    queryFn: ({ signal }) => billingApi.operatorStatement(id, signal),
  });
  const back = (
    <Button variant="ghost" compact iconStart={ArrowRight} onClick={onBack}>
      {o05.back}
    </Button>
  );
  if (detail.isError && !detail.data)
    return (
      <div className="st-stack">
        {back}
        <QueryError error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  if (!detail.data)
    return (
      <div className="st-stack">
        {back}
        <PageSkeleton />
      </div>
    );
  return <StatementBody s={detail.data} me={me} back={back} />;
}

function StatementBody({ s, me, back }: { s: SettlementDetail; me: Me; back: React.ReactNode }) {
  const online = useOnline();
  const [disputing, setDisputing] = useState(false);
  const dispute = useStaffCommand(
    (reason: string, key: string) => billingApi.dispute(s.id, { expected_version: s.version, reason }, key),
    {
      successMessage: o05.disputeDone,
      invalidate: [billingKeys.operatorStatement(s.id), billingKeys.operatorStatements],
      onSuccess: () => setDisputing(false),
    },
  );
  return (
    <div className="st-stack" data-testid="operator-settlement">
      {back}
      <div className="st-head">
        <div className="st-head__title">
          <h2 className="pt-section-title">
            <bdi dir="ltr" className="pt-num">
              {s.period}
            </bdi>
          </h2>
          <SettlementChip status={s.status} />
        </div>
        {operatorCanDispute(me.permissions, s.status) ? (
          <div className="st-head__actions">
            <Button compact variant="secondary" disabled={!online} onClick={() => setDisputing(true)}>
              {o05.dispute}
            </Button>
          </div>
        ) : null}
      </div>
      <Card>
        <StatementBreakdown statement={s} />
      </Card>
      {s.dispute_reason || s.dispute_resolution || s.paid_reference ? (
        <Card>
          <dl className="pt-kv">
            {s.dispute_reason ? (
              <>
                <dt>{o05.disputeReason}</dt>
                <dd>{s.dispute_reason}</dd>
              </>
            ) : null}
            {s.dispute_resolution ? (
              <>
                <dt>{o05.resolution}</dt>
                <dd>{s.dispute_resolution}</dd>
              </>
            ) : null}
            {s.paid_reference ? (
              <>
                <dt>{o05.paidRef}</dt>
                <dd>
                  <bdi dir="ltr" className="pt-num">
                    {s.paid_reference}
                  </bdi>{' '}
                  · {s.paid_on}
                </dd>
              </>
            ) : null}
          </dl>
        </Card>
      ) : null}
      {s.invoices.length ? (
        <Section title={o05.invoices}>
          <ul className="st-stack">
            {s.invoices.map((i) => (
              <li key={i.id}>
                <span className="font-bold">
                  {invoiceKind[i.kind]}{' '}
                  <bdi dir="ltr" className="pt-num">
                    {i.number}
                  </bdi>
                </span>
                <Money halalas={i.total_halalas} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <Section title={o05.lines}>
        <LinesList lines={s.lines} />
      </Section>
      <ReasonDialog
        id="settlement-dispute"
        open={disputing}
        onOpenChange={setDisputing}
        title={o05.disputeTitle}
        body={o05.disputeBody}
        confirmLabel={o05.dispute}
        pending={dispute.pending}
        error={dispute.message}
        reasonError={dispute.fields.reason ?? null}
        onConfirm={(reason) => dispute.run(reason)}
      />
    </div>
  );
}

/**
 * O-06 «اشتراك النظام» (V2-042; DEC-547): the operator's legal data, its contract with POINT in force and their history,
 * its active venues (what the monthly fee counts) and POINT's tax invoices with a short private PDF link.
 */
export function SubscriptionSection() {
  const view = useQuery({
    queryKey: billingKeys.subscription,
    queryFn: ({ signal }) => billingApi.subscription(signal),
  });
  const [pdfIssue, setPdfIssue] = useState<string | null>(null);
  if (view.isError && !view.data)
    return <QueryError error={view.error} onRetry={() => void view.refetch()} />;
  if (!view.data) return <PageSkeleton />;
  const v = view.data;
  const openPdf = async (id: string) => {
    setPdfIssue(null);
    // the link lives a few minutes: read the invoice again for a fresh one
    const fresh = await billingApi.operatorInvoice(id);
    if (!fresh.pdf_url) return setPdfIssue(o06.pdfPending);
    window.open(fresh.pdf_url, '_blank', 'noopener,noreferrer');
  };
  const c = v.contract;
  return (
    <div className="st-stack" data-testid="operator-subscription">
      <Card>
        <dl className="pt-kv">
          <dt>{o06.legalName}</dt>
          <dd>{v.operator.legal_name ?? v.operator.name_ar}</dd>
          <dt>{o06.vatNumber}</dt>
          <dd>
            <bdi dir="ltr" className="pt-num">
              {v.operator.vat_number ?? '—'}
            </bdi>
          </dd>
          <dt>{o06.crNumber}</dt>
          <dd>
            <bdi dir="ltr" className="pt-num">
              {v.operator.cr_number ?? '—'}
            </bdi>
          </dd>
        </dl>
      </Card>
      <Section title={o06.contract}>
        {c ? (
          <Card>
            <dl className="pt-kv">
              <dt>{o06.fee}</dt>
              <dd>
                <Money halalas={c.saas_fee_halalas_per_venue} strong /> · {o06.cycle[c.saas_cycle]}
              </dd>
              <dt>{o06.payout}</dt>
              <dd>
                <Money halalas={c.subscriber_visit_payout_halalas} />
              </dd>
              <dt>{o06.commission}</dt>
              <dd>
                <bdi dir="ltr" className="pt-num">
                  {(c.app_payment_commission_bp / 100).toFixed(2)}%
                </bdi>
              </dd>
            </dl>
            <p className="text-sm text-text-muted">
              {[fmt(o06.since, { from: c.starts_on }), c.ends_on ? fmt(o06.until, { to: c.ends_on }) : null]
                .filter(Boolean)
                .join(' · ')}{' '}
              · {fmt(o06.activeVenues, { n: String(v.active_venues) })}
            </p>
          </Card>
        ) : (
          <EmptyState title={o06.noContract} />
        )}
      </Section>
      {v.contracts.length > 1 ? (
        <Section title={o06.contracts}>
          <ul className="st-stack">
            {v.contracts.map((k) => (
              <li key={k.id}>
                <span>
                  <Money halalas={k.saas_fee_halalas_per_venue} /> · {o06.cycle[k.saas_cycle]}
                  <span className="block text-sm text-text-muted">
                    {k.starts_on} — {k.ends_on ?? '…'}
                  </span>
                </span>
                <span>{o06.state[k.state]}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <Section title={o06.invoices}>
        {pdfIssue ? <p className="text-sm text-text-muted">{pdfIssue}</p> : null}
        {v.invoices.length ? (
          <DataTable
            layout="auto"
            loading={false}
            rows={v.invoices}
            rowKey={(i) => i.id}
            columns={[
              {
                key: 'number',
                label: p10.kind,
                render: (i) => (
                  <span>
                    <bdi dir="ltr" className="pt-num font-bold">
                      {i.number}
                    </bdi>
                    <span className="block text-sm text-text-muted">{invoiceKind[i.kind]}</span>
                  </span>
                ),
              },
              {
                key: 'period',
                label: p09.period,
                render: (i) => (
                  <bdi dir="ltr" className="pt-num">
                    {i.period_start?.slice(0, 7) ?? '—'}
                  </bdi>
                ),
              },
              { key: 'total', label: p10.total, render: (i) => formatHalalas(i.total_halalas) },
              { key: 'status', label: p10.status, render: (i) => <ZatcaChip status={i.status} /> },
              { key: 'issued', label: p10.issued, render: (i) => formatDateTime(i.issued_at) },
              {
                key: 'pdf',
                label: o06.pdf,
                render: (i) => (
                  <Button variant="secondary" compact iconStart={FileText} onClick={() => void openPdf(i.id)}>
                    {o06.pdf}
                  </Button>
                ),
              },
            ]}
          />
        ) : (
          <EmptyState icon={FileText} title={o06.noInvoices} />
        )}
      </Section>
    </div>
  );
}
