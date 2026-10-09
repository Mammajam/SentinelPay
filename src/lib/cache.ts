/**
 * Tiny in-process TTL cache for hot, near-immutable lookups on the advisory path (validate-cart).
 * Each Cloud Run instance has its own copy, so a change (revocation, merchant re-registration)
 * takes effect on other instances within the TTL. The MONEY path (webhook inspection, capture,
 * re-trigger) never reads through this cache.
 * TTLs are env-tunable; 0 disables a cache entirely (used for deterministic tests).
 */
export class TtlCache<V> {
  private m = new Map<string, { v: V; exp: number }>();
  private ttlMs: () => number;
  private max: number;
  // (plain fields, not parameter properties: Node's type-stripping mode does not support those)
  constructor(ttlMs: () => number, max = 1000) {
    this.ttlMs = ttlMs;
    this.max = max;
  }

  get(k: string): V | undefined {
    const e = this.m.get(k);
    if (!e) return undefined;
    if (e.exp <= Date.now()) { this.m.delete(k); return undefined; }
    return e.v;
  }
  set(k: string, v: V) {
    const ttl = this.ttlMs();
    if (ttl <= 0) return;
    if (this.m.size >= this.max) this.m.delete(this.m.keys().next().value as string); // bounded (FIFO)
    this.m.set(k, { v, exp: Date.now() + ttl });
  }
  delete(k: string) { this.m.delete(k); }
  deleteWhere(pred: (k: string) => boolean) { for (const k of [...this.m.keys()]) if (pred(k)) this.m.delete(k); }
  clear() { this.m.clear(); }
}

export const envMs = (name: string, dflt: number) => () => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 && process.env[name] !== undefined && process.env[name] !== "" ? n : dflt;
};
