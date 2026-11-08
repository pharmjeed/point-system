import { ArrowUpDown, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { components } from '@/i18n/ar';
import { cx } from '@/lib/cx';
import { Button } from './Button';
import { FieldError } from './Field';
import { Icon } from './Icon';
import { Skeleton } from './Skeleton';

export interface DataColumn<Row> {
  key: string;
  label: string;
  sortable?: boolean;
  render?: (row: Row) => ReactNode;
}

export interface DataTableProps<Row> {
  columns: DataColumn<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  /** Rows changed by a live update are tinted instead of moving (03 §4.6). */
  isChanged?: (row: Row) => boolean;
  sort?: { key: string; dir: 'asc' | 'desc' };
  onSort?: (key: string) => void;
  toolbar?: ReactNode;
  /** `auto`: cards below a 1024px container, table from 1024px (03 §3.16). */
  layout?: 'auto' | 'table' | 'cards';
  loading?: boolean;
  loadingMore?: boolean;
  error?: string;
  hasPrev?: boolean;
  hasNext?: boolean;
  onPrev?: () => void;
  onNext?: () => void;
}

/** Supervisor table: sticky header, sorting, filtering toolbar, cursor paging; cards on narrow containers. */
export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  isChanged,
  sort,
  onSort,
  toolbar,
  layout = 'auto',
  loading,
  loadingMore,
  error,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
}: DataTableProps<Row>) {
  const cell = (row: Row, c: DataColumn<Row>): ReactNode =>
    c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? '');
  const table = (
    <div className="pt-table-scroll">
      <table className="pt-table">
        <thead>
          <tr>
            {columns.map((c) => {
              const sorted = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={sorted ? (sort?.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  {c.sortable ? (
                    <button
                      type="button"
                      className={cx('pt-th-sort', sorted && 'is-on')}
                      onClick={() => onSort?.(c.key)}
                    >
                      {c.label}
                      <Icon icon={ArrowUpDown} size={16} />
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading
            ? [0, 1, 2].map((i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td key={c.key}>
                      <Skeleton variant="line" width="70%" />
                    </td>
                  ))}
                </tr>
              ))
            : rows.map((row) => (
                <tr key={rowKey(row)} className={isChanged?.(row) ? 'is-changed' : undefined}>
                  {columns.map((c) => (
                    <td key={c.key}>{cell(row, c)}</td>
                  ))}
                </tr>
              ))}
        </tbody>
      </table>
    </div>
  );
  const cards = (
    <ul className="pt-table-cards">
      {rows.map((row) => (
        <li key={rowKey(row)} className="pt-card">
          {columns.map((c) => (
            <div key={c.key} className="pt-table-cards__row">
              <span className="pt-table-cards__k">{c.label}</span>
              <span>{cell(row, c)}</span>
            </div>
          ))}
        </li>
      ))}
    </ul>
  );
  return (
    <div className={cx('pt-datatable', `pt-datatable--${layout}`)}>
      {toolbar ? <div className="pt-datatable__bar">{toolbar}</div> : null}
      {error ? <FieldError role="alert">{error}</FieldError> : null}
      {layout !== 'cards' ? table : null}
      {layout !== 'table' ? cards : null}
      {hasPrev || hasNext ? (
        <div className="pt-datatable__pager">
          <Button variant="secondary" compact disabled={!hasPrev} onClick={onPrev}>
            {components.table.prev}
          </Button>
          <Button variant="secondary" compact disabled={!hasNext} loading={loadingMore} onClick={onNext}>
            <span className="inline-flex items-center gap-1">
              {components.table.next}
              <Icon icon={ChevronRight} size={16} directional />
            </span>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
