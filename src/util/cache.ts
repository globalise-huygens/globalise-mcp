// A small LRU cache with a time-to-live. Promises are cached as well, so concurrent requests
// for the same resource share one upstream call.

export class LruCache<V> {
  private readonly entries = new Map<string, { value: V; expires: number }>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(maxEntries: number, ttlMs: number) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires < Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Re-insert to mark as most recently used.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expires: Date.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  /** Returns the cached value, or computes, caches and returns it. Failed computations are not cached. */
  async getOrCompute(key: string, compute: () => Promise<V>): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const promise = compute();
    this.set(key, promise as V);
    try {
      const value = await promise;
      this.set(key, value);
      return value;
    } catch (error) {
      this.delete(key);
      throw error;
    }
  }
}
