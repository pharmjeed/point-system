import { Fragment, type ReactNode } from 'react';
import { TicketNumber } from '@/components/TicketNumber';

/**
 * `fmt()` for JSX: fills `{name}` placeholders with nodes, so plates, codes and serials inside Arabic text
 * can be isolated with `<bdi>` (02 §1.2, §7 item 3). Unknown placeholders stay visible.
 */
export function fmtNode(template: string, vars: Record<string, ReactNode>): ReactNode {
  return template.split(/(\{[a-zA-Z0-9_]+\})/).map((part, i) => {
    const m = /^\{([a-zA-Z0-9_]+)\}$/.exec(part);
    const key = m?.[1];
    if (key !== undefined && key in vars) return <Fragment key={i}>{vars[key]}</Fragment>;
    return part;
  });
}

/**
 * A dictionary sentence with «#{n}» as the ticket number component (`<bdi dir="ltr">`, Mono): in Arabic
 * text a bare «#125» is reordered to «125#» by the bidi algorithm (digits after Arabic letters are AN).
 */
export function withTicket(template: string, n: number, vars: Record<string, ReactNode> = {}): ReactNode {
  return fmtNode(template.replace('#{n}', '{ticket_no}'), { ...vars, ticket_no: <TicketNumber n={n} /> });
}

/** A left-to-right value inside Arabic text (serials, plate digits, codes). */
export function Ltr({ children }: { children: ReactNode }) {
  return (
    <bdi dir="ltr" className="pt-num">
      {children}
    </bdi>
  );
}
