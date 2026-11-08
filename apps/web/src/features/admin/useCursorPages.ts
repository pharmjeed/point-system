import { useEffect, useState } from 'react';

/**
 * Cursor paging for DataTable (07 §1.7: opaque `meta.next_cursor`): a stack of the cursors already visited so
 * «السابق» returns to the previous page; a filter change starts again from the first page.
 */
export function useCursorPages(filters: Record<string, unknown>) {
  const key = JSON.stringify(filters);
  const [stack, setStack] = useState<Array<string | null>>([null]);
  useEffect(() => {
    setStack([null]);
  }, [key]);
  const cursor = stack[stack.length - 1] ?? null;
  return {
    cursor,
    hasPrev: stack.length > 1,
    prev: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
    next: (nextCursor: string | null) => {
      if (nextCursor) setStack((s) => [...s, nextCursor]);
    },
    reset: () => setStack([null]),
  };
}
