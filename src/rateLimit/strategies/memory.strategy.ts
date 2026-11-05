import type { Clock, RateLimiter, RateLimitPolicy, RateLimitResult } from '../rateLimit.types';
import { systemClock } from '../rateLimit.types';

/**
 * In-memory implementations of every algorithm. State is per process, so use these for
 * tests, local development or single-instance deployments. Idle keys are evicted.
 */

/** Removes entries idle for longer than `ttlMs` once the map grows past a threshold. */
function evictIdle<T extends { touched: number }>(store: Map<string, T>, now: number, ttlMs: number): void {
  if (store.size < 10_000) return;
  for (const [key, value] of store) {
    if (now - value.touched > ttlMs) store.delete(key);
  }
}

/**
 * Token bucket: allows bursts up to capacity while sustaining `limit / windowSeconds` per second.
 */
export class MemoryTokenBucket implements RateLimiter {
  readonly algorithm = 'token-bucket' as const;
  private readonly buckets = new Map<string, { tokens: number; last: number; touched: number }>();

  constructor(private readonly policy: RateLimitPolicy, private readonly clock: Clock = systemClock) {}

  async consume(key: string, cost = 1): Promise<RateLimitResult> {
    const now = this.clock.now();
    const capacity = this.policy.burst ?? this.policy.limit;
    const refillPerSecond = this.policy.limit / this.policy.windowSeconds;
    const bucket = this.buckets.get(key) ?? { tokens: capacity, last: now, touched: now };

    const elapsedSeconds = Math.max(0, now - bucket.last) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSeconds * refillPerSecond);
    bucket.last = now;
    bucket.touched = now;

    const allowed = bucket.tokens >= cost;
    if (allowed) bucket.tokens -= cost;
    this.buckets.set(key, bucket);
    evictIdle(this.buckets, now, (capacity / refillPerSecond + 1) * 1000);

    return {
      allowed,
      limit: capacity,
      remaining: Math.floor(bucket.tokens),
      retryAfterSeconds: allowed ? 0 : Math.ceil((cost - bucket.tokens) / refillPerSecond),
    };
  }
}

/**
 * Leaky bucket (as a meter): requests fill the bucket, which drains at a constant rate.
 * Produces a smoother output rate than a token bucket.
 */
export class MemoryLeakyBucket implements RateLimiter {
  readonly algorithm = 'leaky-bucket' as const;
  private readonly buckets = new Map<string, { level: number; last: number; touched: number }>();

  constructor(private readonly policy: RateLimitPolicy, private readonly clock: Clock = systemClock) {}

  async consume(key: string, cost = 1): Promise<RateLimitResult> {
    const now = this.clock.now();
    const capacity = this.policy.burst ?? this.policy.limit;
    const leakPerSecond = this.policy.limit / this.policy.windowSeconds;
    const bucket = this.buckets.get(key) ?? { level: 0, last: now, touched: now };

    const elapsedSeconds = Math.max(0, now - bucket.last) / 1000;
    bucket.level = Math.max(0, bucket.level - elapsedSeconds * leakPerSecond);
    bucket.last = now;
    bucket.touched = now;

    const allowed = bucket.level + cost <= capacity;
    if (allowed) bucket.level += cost;
    this.buckets.set(key, bucket);
    evictIdle(this.buckets, now, (capacity / leakPerSecond + 1) * 1000);

    return {
      allowed,
      limit: capacity,
      remaining: Math.max(0, Math.floor(capacity - bucket.level)),
      retryAfterSeconds: allowed ? 0 : Math.ceil((bucket.level + cost - capacity) / leakPerSecond),
    };
  }
}

/** Fixed window: a simple counter that resets at each window boundary. */
export class MemoryFixedWindow implements RateLimiter {
  readonly algorithm = 'fixed-window' as const;
  private readonly windows = new Map<string, { windowStart: number; count: number; touched: number }>();

  constructor(private readonly policy: RateLimitPolicy, private readonly clock: Clock = systemClock) {}

  async consume(key: string, cost = 1): Promise<RateLimitResult> {
    const now = this.clock.now();
    const windowMs = this.policy.windowSeconds * 1000;
    const windowStart = Math.floor(now / windowMs) * windowMs;
    let entry = this.windows.get(key);
    if (!entry || entry.windowStart !== windowStart) {
      entry = { windowStart, count: 0, touched: now };
    }
    entry.touched = now;

    const allowed = entry.count + cost <= this.policy.limit;
    if (allowed) entry.count += cost;
    this.windows.set(key, entry);
    evictIdle(this.windows, now, windowMs * 2);

    return {
      allowed,
      limit: this.policy.limit,
      remaining: Math.max(0, this.policy.limit - entry.count),
      retryAfterSeconds: allowed ? 0 : Math.ceil((windowStart + windowMs - now) / 1000),
    };
  }
}

/** Sliding window log: stores every request timestamp for exact, boundary-free limiting. */
export class MemorySlidingWindowLog implements RateLimiter {
  readonly algorithm = 'sliding-window-log' as const;
  private readonly logs = new Map<string, { stamps: number[]; touched: number }>();

  constructor(private readonly policy: RateLimitPolicy, private readonly clock: Clock = systemClock) {}

  async consume(key: string, cost = 1): Promise<RateLimitResult> {
    const now = this.clock.now();
    const windowMs = this.policy.windowSeconds * 1000;
    const entry = this.logs.get(key) ?? { stamps: [], touched: now };
    entry.stamps = entry.stamps.filter((stamp) => stamp > now - windowMs);
    entry.touched = now;

    const allowed = entry.stamps.length + cost <= this.policy.limit;
    let retryAfterSeconds = 0;
    if (allowed) {
      for (let i = 0; i < cost; i += 1) entry.stamps.push(now);
    } else {
      const index = Math.min(entry.stamps.length - 1, entry.stamps.length + cost - this.policy.limit - 1);
      const releasing = entry.stamps[Math.max(0, index)] ?? now;
      retryAfterSeconds = Math.max(1, Math.ceil((releasing + windowMs - now) / 1000));
    }
    this.logs.set(key, entry);
    evictIdle(this.logs, now, windowMs * 2);

    return {
      allowed,
      limit: this.policy.limit,
      remaining: Math.max(0, this.policy.limit - entry.stamps.length),
      retryAfterSeconds,
    };
  }
}

/**
 * Sliding window counter: approximates a sliding window by weighting the previous
 * fixed window. Constant memory per key with far less boundary burstiness than a fixed window.
 */
export class MemorySlidingWindowCounter implements RateLimiter {
  readonly algorithm = 'sliding-window-counter' as const;
  private readonly windows = new Map<string, { windowStart: number; current: number; previous: number; touched: number }>();

  constructor(private readonly policy: RateLimitPolicy, private readonly clock: Clock = systemClock) {}

  async consume(key: string, cost = 1): Promise<RateLimitResult> {
    const now = this.clock.now();
    const windowMs = this.policy.windowSeconds * 1000;
    const windowStart = Math.floor(now / windowMs) * windowMs;
    let entry = this.windows.get(key) ?? { windowStart, current: 0, previous: 0, touched: now };

    if (entry.windowStart !== windowStart) {
      const consecutive = windowStart - entry.windowStart === windowMs;
      entry = { windowStart, current: 0, previous: consecutive ? entry.current : 0, touched: now };
    }
    entry.touched = now;

    const elapsedFraction = (now - windowStart) / windowMs;
    const weighted = entry.previous * (1 - elapsedFraction) + entry.current;
    const allowed = weighted + cost <= this.policy.limit;
    if (allowed) entry.current += cost;
    this.windows.set(key, entry);
    evictIdle(this.windows, now, windowMs * 3);

    const used = weighted + (allowed ? cost : 0);
    return {
      allowed,
      limit: this.policy.limit,
      remaining: Math.max(0, Math.floor(this.policy.limit - used)),
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)),
    };
  }
}
