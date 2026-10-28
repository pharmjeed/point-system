/**
 * In-process token buckets (PNT-096, 07 §1.9). A bucket of `limit` tokens refills continuously at
 * `limit / window`, so a client may burst up to the limit and then gets one request every `window / limit`.
 * Time is passed in (the injected Clock), so tests control it.
 *
 * The store is per process (05 §4 «حد المعدل لكل نسخة»): with N api instances a client can reach N × limit.
 * The protections that must hold across instances live in PostgreSQL (account lock after
 * security.max_login_attempts, idempotency keys, business limits such as handover.max_resends).
 */
export interface RateDecision {
  allowed: boolean;
  limit: number;
  /** whole tokens left after this request */
  remaining: number;
  /** seconds until the bucket is full again (`RateLimit-Reset`) */
  resetS: number;
  /** seconds until one more request fits (`Retry-After`), 0 when allowed */
  retryAfterS: number;
}

interface Bucket {
  tokens: number;
  at: number;
  /** when the bucket is full again: an idle key past this point carries no information and is dropped */
  fullAt: number;
}

export interface TokenBucketOptions {
  /** upper bound on remembered keys; beyond it the least recently used keys are dropped */
  maxKeys?: number;
  /** how often full (idle) buckets are swept */
  sweepEveryMs?: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly maxKeys: number;
  private readonly sweepEveryMs: number;
  private lastSweep = 0;

  constructor(opts: TokenBucketOptions = {}) {
    this.maxKeys = opts.maxKeys ?? 100_000;
    this.sweepEveryMs = opts.sweepEveryMs ?? 60_000;
  }

  /** Number of remembered keys (tests, metrics). */
  get size(): number {
    return this.buckets.size;
  }

  take(key: string, limit: number, windowMs: number, nowMs: number, cost = 1): RateDecision {
    if (nowMs - this.lastSweep >= this.sweepEveryMs) this.sweep(nowMs);
    const ratePerMs = limit / windowMs;
    const prev = this.buckets.get(key);
    let tokens = limit;
    if (prev) {
      const elapsed = Math.max(0, nowMs - prev.at);
      tokens = Math.min(limit, prev.tokens + elapsed * ratePerMs);
      this.buckets.delete(key); // re-inserted below: Map order = least recently used first
    }
    const allowed = tokens >= cost;
    if (allowed) tokens -= cost;
    const missingMs = (limit - tokens) / ratePerMs;
    this.buckets.set(key, { tokens, at: nowMs, fullAt: nowMs + missingMs });
    while (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
    return {
      allowed,
      limit,
      remaining: Math.max(0, Math.floor(tokens)),
      resetS: Math.ceil(missingMs / 1000),
      retryAfterS: allowed ? 0 : Math.max(1, Math.ceil((cost - tokens) / ratePerMs / 1000)),
    };
  }

  /** Forgets every key (tests). */
  clear(): void {
    this.buckets.clear();
  }

  private sweep(nowMs: number): void {
    this.lastSweep = nowMs;
    for (const [k, b] of this.buckets) if (b.fullAt <= nowMs) this.buckets.delete(k);
  }
}
