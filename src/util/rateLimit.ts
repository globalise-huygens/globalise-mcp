// Token bucket per client. A second line of defence: in production Traefik's rateLimit middleware
// should do this at the edge, but the server must stay safe when exposed without it.

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updated: number }>();
  private readonly capacity: number;
  private readonly refillPerMs: number;

  constructor(perWindow: number, windowMs: number) {
    this.capacity = perWindow;
    this.refillPerMs = perWindow / windowMs;
  }

  /** Takes one token. Returns 0 when allowed, otherwise the milliseconds until a token is available. */
  take(key: string, now = Date.now()): number {
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updated: now };
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (now - bucket.updated) * this.refillPerMs);
    bucket.updated = now;
    this.buckets.set(key, bucket);
    if (this.buckets.size > 10_000) this.prune(now);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - bucket.tokens) / this.refillPerMs);
  }

  private prune(now: number) {
    for (const [key, bucket] of this.buckets) {
      if (bucket.tokens + (now - bucket.updated) * this.refillPerMs >= this.capacity) this.buckets.delete(key);
    }
  }
}
