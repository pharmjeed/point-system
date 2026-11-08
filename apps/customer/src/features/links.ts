/**
 * Incoming links (V2-052, DEC-566), read by src/app/+native-intent.ts before Expo Router routes them.
 *
 * - `https://{CUSTOMER_LINK_DOMAIN}/app` and anything under `/app/` (universal links / App Links; the domain serves
 *   infra/well-known/) open the app at its entry, which sends journey R1 where it continues (onboarding.ts);
 *   `/app/visit/{uuid}` opens C-12 of that visit (the server still decides whether this account may see it).
 * - `{scheme}://pay/return`, the gateway's return after 3-D Secure (DEC-512): the in-app browser closes on it and
 *   the result comes from the server, so the link itself changes nothing — the app stays where it is.
 * - Every other path is left to the router as it is.
 */
export const APP_LINK_PREFIX = '/app';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The path part of a URL or path: `https://host/a/b?x` → `/a/b`; `scheme://pay/return` → `/pay/return`. */
export function linkPath(input: string): string {
  let rest = input.trim();
  const url = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(rest);
  if (url) {
    const scheme = (url[1] as string).toLowerCase();
    const after = url[2] as string;
    // http(s): drop the host; a custom scheme has no host, its first segment is part of the route
    rest = scheme === 'http' || scheme === 'https' ? after.replace(/^[^/?#]*/, '') : `/${after}`;
  }
  rest = rest.replace(/[?#].*$/, '');
  if (!rest.startsWith('/')) rest = `/${rest}`;
  rest = rest.replace(/\/{2,}/g, '/');
  return rest.length > 1 ? rest.replace(/\/$/, '') : rest;
}

/**
 * Where an incoming link goes: a router path, the input unchanged (the router's own matching), or `null` to stay on
 * the current screen (Expo Router's `redirectSystemPath` contract).
 */
export function systemPathFor(input: string, initial: boolean): string | null {
  const path = linkPath(input);
  if (path === '/pay/return') return initial ? '/' : null;
  if (path === APP_LINK_PREFIX || path.startsWith(`${APP_LINK_PREFIX}/`)) {
    const visit = /^\/visit\/([^/]+)$/.exec(path.slice(APP_LINK_PREFIX.length));
    if (visit && UUID.test(visit[1] as string)) return `/visit/${(visit[1] as string).toLowerCase()}`;
    return '/';
  }
  return input;
}
