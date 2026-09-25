const MAX_ENTRIES = 10_000;

/**
 * Small Map-based cache with a TTL. A ttl of 0 disables it.
 *
 * Every invalidation bumps a generation counter. A load that started before an invalidation
 * is not stored when it finishes, so a slow read can never put stale data back in the cache.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expires: number }>();
  private generation = 0;

  constructor(private readonly ttlMs: number) {}

  async getOrLoad(key: string, load: () => Promise<V>): Promise<V> {
    const entry = this.entries.get(key);
    if (entry && entry.expires > Date.now()) return entry.value;
    if (entry) this.entries.delete(key);

    const generation = this.generation;
    const value = await load();
    if (this.ttlMs > 0 && generation === this.generation) this.store(key, value);
    return value;
  }

  delete(key: string): void {
    this.entries.delete(key);
    this.generation++;
  }

  clear(): void {
    this.entries.clear();
    this.generation++;
  }

  /** Get the cached value if it exists and hasn't expired, or undefined. Never loads. */
  cached(key: string = "catalog"): V | undefined {
    const entry = this.entries.get(key);
    if (entry && entry.expires > Date.now()) return entry.value;
    if (entry) this.entries.delete(key);
    return undefined;
  }

  private store(key: string, value: V): void {
    this.entries.delete(key); // re-insert so Map order stays oldest-first
    this.entries.set(key, { value, expires: Date.now() + this.ttlMs });
    if (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }
}
