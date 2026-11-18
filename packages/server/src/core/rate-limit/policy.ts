import {
  findPlatformRoute,
  findRoute,
  fromExpressPath,
  type HttpMethod,
  type RateLimitClass,
} from '@point/shared';
import { findCustomerRoute } from '@point/shared/customer';
import type { Env } from '../config/env.js';

/** Who a bucket belongs to: the client address before login, the user after, or the device (session). */
export type RateLimitSubject = 'ip' | 'user' | 'device';

export interface RateRule {
  /** bucket namespace: the class name, or the name of an extra rule */
  name: string;
  limit: number;
  windowMs: number;
  subject: RateLimitSubject;
}

const MINUTE = 60_000;

function rule(name: string, limit: number, windowMs: number, subject: RateLimitSubject): RateRule | null {
  return limit > 0 ? { name, limit, windowMs, subject } : null; // 0 = no application limit for the class
}

/**
 * 07 §1.9 per class (defaults in core/config/env.ts): `auth` 10/min per IP; `command` 60/min, `write` 30/min,
 * `read` 300/min per user; `device` 60/min per device; `export` 5/hour per user; `webhook` per source IP
 * (05 §14.3 — a valve far above Meta's delivery rate); `health` is not limited (internal monitoring).
 */
export function rateLimitRules(env: Env): Readonly<Record<RateLimitClass, RateRule | null>> {
  return {
    auth: rule('auth', env.RATE_LIMIT_AUTH_PER_MIN, MINUTE, 'ip'),
    command: rule('command', env.RATE_LIMIT_COMMANDS_PER_MIN, MINUTE, 'user'),
    write: rule('write', env.RATE_LIMIT_WRITES_PER_MIN, MINUTE, 'user'),
    read: rule('read', env.RATE_LIMIT_READS_PER_MIN, MINUTE, 'user'),
    device: rule('device', env.RATE_LIMIT_DEVICE_PER_MIN, MINUTE, 'device'),
    export: rule('export', env.RATE_LIMIT_EXPORTS_PER_HOUR, 60 * MINUTE, 'user'),
    webhook: rule('webhook', env.RATE_LIMIT_WEBHOOK_PER_MIN, MINUTE, 'ip'),
    health: null,
  };
}

/** Rules applied on top of the route's class (07 §1.9: «20 خلال 10 ثوانٍ لقبول العروض»). */
export function extraRateRules(env: Env): Readonly<Record<string, RateRule>> {
  const accept = rule('accept', env.RATE_LIMIT_ACCEPT_PER_10S, 10_000, 'user');
  return accept ? { 'POST /v1/task-offers/{offerId}/accept': accept } : {};
}

/**
 * The class of a matched route: ROUTES (canon §9), PLATFORM_ROUTES or CUSTOMER_ROUTES (V2), all checked against
 * `x-rate-limit-class`; a route in neither (test controllers) falls back to the default of its method.
 */
export function rateLimitClassOf(method: string, expressPath: string): RateLimitClass {
  const m = method.toUpperCase() as HttpMethod;
  const path = fromExpressPath(expressPath);
  return (
    findRoute(m, path)?.rateLimitClass ??
    findPlatformRoute(m, path)?.rateLimitClass ??
    findCustomerRoute(m, path)?.rateLimitClass ??
    (m === 'GET' ? 'read' : 'command')
  );
}

/**
 * The bucket key of a client address: IPv4 as is, IPv6 by its /64 prefix (one subscriber or host usually
 * owns a whole /64, so rotating the interface id must not buy a fresh bucket).
 */
export function clientAddressKey(ip: string | undefined | null): string {
  if (!ip) return 'unknown';
  const v4mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (v4mapped?.[1]) return v4mapped[1];
  if (!ip.includes(':')) return ip;
  const [head = '', tail = ''] = ip.split('%')[0]!.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = ip.includes('::') && tail ? tail.split(':') : [];
  const groups = ip.includes('::')
    ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t]
    : h;
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}
