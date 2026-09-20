/**
 * Organic Activity Engine — HTTP rate limiter.
 *
 * Sliding-window in-memory limiter per IP (or per key when provided).
 * No external deps. Designed for a single-process bridge with low RPS.
 *
 * Two windows:
 *  - burst:  short-term spike protection (e.g. 10 req / 60s)
 *  - hourly: sustained-load protection    (e.g. 30 req / 3600s)
 *
 * Returns { allowed, retryAfterSeconds, remaining }.
 */

export class RateLimiter {
  constructor({ burstLimit = 10, burstWindowMs = 60_000, hourlyLimit = 30, hourlyWindowMs = 3_600_000 } = {}) {
    this.burstLimit = burstLimit;
    this.burstWindowMs = burstWindowMs;
    this.hourlyLimit = hourlyLimit;
    this.hourlyWindowMs = hourlyWindowMs;
    this.buckets = new Map(); // key → { burst: number[], hourly: number[] }
    // Periodic cleanup of stale buckets to prevent unbounded growth.
    this._cleanupInterval = setInterval(() => this._cleanup(), 300_000).unref?.();
  }

  _cleanup() {
    const now = Date.now();
    for (const [key, b] of this.buckets) {
      this._prune(b.burst, now, this.burstWindowMs);
      this._prune(b.hourly, now, this.hourlyWindowMs);
      if (b.burst.length === 0 && b.hourly.length === 0) {
        this.buckets.delete(key);
      }
    }
  }

  _prune(arr, now, windowMs) {
    const cutoff = now - windowMs;
    while (arr.length > 0 && arr[0] < cutoff) arr.shift();
  }

  check(key = 'anonymous') {
    let b = this.buckets.get(key);
    if (!b) {
      b = { burst: [], hourly: [] };
      this.buckets.set(key, b);
    }
    const now = Date.now();
    this._prune(b.burst, now, this.burstWindowMs);
    this._prune(b.hourly, now, this.hourlyWindowMs);

    if (b.burst.length >= this.burstLimit) {
      const retryAfter = Math.ceil((b.burst[0] + this.burstWindowMs - now) / 1000);
      return { allowed: false, retryAfterSeconds: Math.max(1, retryAfter), remaining: 0, scope: 'burst' };
    }
    if (b.hourly.length >= this.hourlyLimit) {
      const retryAfter = Math.ceil((b.hourly[0] + this.hourlyWindowMs - now) / 1000);
      return { allowed: false, retryAfterSeconds: Math.max(1, retryAfter), remaining: 0, scope: 'hourly' };
    }

    b.burst.push(now);
    b.hourly.push(now);
    return {
      allowed: true,
      retryAfterSeconds: 0,
      remaining: {
        burst: this.burstLimit - b.burst.length,
        hourly: this.hourlyLimit - b.hourly.length,
      },
      scope: null,
    };
  }
}

// Pre-configured limiters for each endpoint.
// /publish is stricter: each publish is expensive (Playwright session) and
// a flood would trigger platform-side anti-abuse on the accounts.
export const publishLimiter = new RateLimiter({
  burstLimit: Number(process.env.RATE_LIMIT_PUBLISH_BURST || 5),
  burstWindowMs: 60_000,
  hourlyLimit: Number(process.env.RATE_LIMIT_PUBLISH_HOURLY || 20),
  hourlyWindowMs: 3_600_000,
});

// /warmup is the strictest: each warmup opens a browser, navigates, and
// potentially logs in — a flood would burn through the daily login budget
// and trigger login-based anti-abuse.
export const warmupLimiter = new RateLimiter({
  burstLimit: Number(process.env.RATE_LIMIT_WARMUP_BURST || 3),
  burstWindowMs: 60_000,
  hourlyLimit: Number(process.env.RATE_LIMIT_WARMUP_HOURLY || 8),
  hourlyWindowMs: 3_600_000,
});

// /organic-status is read-only and cheap; allow a higher limit.
export const statusLimiter = new RateLimiter({
  burstLimit: Number(process.env.RATE_LIMIT_STATUS_BURST || 20),
  burstWindowMs: 60_000,
  hourlyLimit: Number(process.env.RATE_LIMIT_STATUS_HOURLY || 100),
  hourlyWindowMs: 3_600_000,
});
