import type { BlockingDriver, CustodyItem } from '@/api/types';
import { TicketNumber } from '@/components';
import { s06 } from '@/i18n/ar.staff';

/** One custody item: «مفتاح #125» (types from 08 `details.items`). */
export function CustodyItemText({ item }: { item: CustodyItem }) {
  const label = (s06.itemType as Record<string, string>)[item.type] ?? item.type;
  return (
    <span className="inline-flex items-center gap-1">
      <span>{label}</span>
      {item.display_number ? <TicketNumber n={item.display_number} /> : null}
    </span>
  );
}

export function CustodyItemList({ items }: { items: CustodyItem[] }) {
  if (!items.length) return null;
  return (
    <ul className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0">
      {items.map((item, i) => (
        <li key={`${item.type}-${item.ticket_id ?? i}`}>
          <CustodyItemText item={item} />
        </li>
      ))}
    </ul>
  );
}

/** `details.blocking_drivers` of SHIFT_CLOSE_BLOCKED: each driver with what blocks the close (08 §4). */
export function BlockingDrivers({ drivers }: { drivers: BlockingDriver[] }) {
  if (!drivers.length) return null;
  return (
    <ul className="pt-list" data-testid="blocking-drivers">
      {drivers.map((d) => (
        <li key={d.driver.id} className="flex flex-col gap-1 p-3">
          <span className="font-semibold">
            {d.driver.full_name}
            {d.driver.employee_code ? (
              <>
                {' · '}
                <bdi dir="ltr" className="pt-num">
                  {d.driver.employee_code}
                </bdi>
              </>
            ) : null}
          </span>
          <CustodyItemList items={d.items} />
        </li>
      ))}
    </ul>
  );
}
