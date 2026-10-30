/**
 * SingleFlight request coalescer and in-memory TTL micro-cache (TASK-106).
 * Protects Turso database connections by deduplicating identical concurrent queries
 * and caching hot read paths for a short TTL (15-60s).
 */

export class MicroCache<T> {
  private cache: { data: T; expiresAt: number } | null = null;
  private inFlight: Promise<T> | null = null;

  constructor(public readonly ttlMs: number) {}

  async getOrFetch(fetcher: () => Promise<T>): Promise<T> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) {
      return this.cache.data;
    }
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = (async () => {
      try {
        const data = await fetcher();
        this.cache = { data, expiresAt: Date.now() + this.ttlMs };
        return data;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  clear(): void {
    this.cache = null;
    this.inFlight = null;
  }
}

export class KeyedMicroCache<T> {
  private map = new Map<string, { data: T; expiresAt: number }>();
  private inFlight = new Map<string, Promise<T>>();

  constructor(
    public readonly ttlMs: number,
    public readonly maxEntries = 500
  ) {}

  async getOrFetch(key: string, fetcher: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const cached = this.map.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.data;
    }
    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }
    const promise = (async () => {
      try {
        const data = await fetcher();
        if (this.map.size >= this.maxEntries) {
          const oldestKey = this.map.keys().next().value;
          if (oldestKey) this.map.delete(oldestKey);
        }
        this.map.set(key, { data, expiresAt: Date.now() + this.ttlMs });
        return data;
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, promise);
    return promise;
  }

  clear(): void {
    this.map.clear();
    this.inFlight.clear();
  }
}
