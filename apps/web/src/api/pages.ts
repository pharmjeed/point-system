import { api, type RequestOptions } from './client';

/** Largest page the API serves (07 §1.7). */
export const MAX_PAGE = 200;

/**
 * Reads a cursor-paged list to the end (07 §1.7: `?limit=` + `?cursor=` from `meta.next_cursor`). Setup and
 * layout lists are small (a venue has tens to hundreds of spots), so the screens hold the whole list;
 * `maxPages` stops a runaway loop.
 */
export async function fetchAllPages<T>(
  path: string,
  query: RequestOptions['query'] = {},
  options: { signal?: AbortSignal; maxPages?: number } = {},
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null | undefined;
  const maxPages = options.maxPages ?? 20;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await api.get<T[]>(path, {
      query: { ...query, limit: MAX_PAGE, cursor: cursor ?? undefined },
      signal: options.signal,
    });
    items.push(...(result.data ?? []));
    cursor = result.meta.next_cursor;
    if (!cursor) break;
  }
  return items;
}
