import { db } from "./client.ts";
import { appendAudit } from "./audit.ts";
import { anchorBody, mismatchedAnchors, signAnchor, type Anchor } from "../audit/anchor.ts";

const isLocal = (h: string) => h === "localhost" || h === "127.0.0.1";

/** Commit the current chain head. Sink: external HTTP if ANCHOR_SINK_URL is set, else DB only. */
export async function createAnchor(): Promise<{ seq: number; hash: string; sink: "db" | "http" } | null> {
  const { rows } = await db().query("SELECT seq::int AS seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1");
  if (!rows[0]) return null;
  const a: Anchor = { seq: rows[0].seq, hash: rows[0].hash, at: new Date().toISOString() };

  let sink: "db" | "http" = "db";
  let ref: string | null = null;
  const url = process.env.ANCHOR_SINK_URL;
  if (url) {
    const u = new URL(url);
    if (u.protocol !== "https:" && !isLocal(u.hostname)) throw new Error("ANCHOR_SINK_URL must be https");
    const key = process.env.ANCHOR_HMAC_KEY;
    if (!key || key.length < 32) throw new Error("ANCHOR_HMAC_KEY (>=32 chars) required with ANCHOR_SINK_URL");
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-sentinel-signature": signAnchor(a, key) },
      body: anchorBody(a),
      signal: AbortSignal.timeout(10_000),
    });
    // Only claim external anchoring if the sink really accepted it.
    if (!res.ok) throw new Error(`anchor sink rejected (${res.status})`);
    sink = "http";
    ref = res.headers.get("x-anchor-ref");
  }

  await db().query("INSERT INTO audit_anchors (seq, hash, sink, sink_ref) VALUES ($1,$2,$3,$4) ON CONFLICT (seq) DO NOTHING", [a.seq, a.hash, sink, ref]);
  await appendAudit("audit.anchored", { seq: a.seq, hash: a.hash, sink });
  return { seq: a.seq, hash: a.hash, sink };
}

/** Re-check every stored anchor against the live chain. */
export async function verifyAnchors(): Promise<{ checked: number; mismatched: number[]; lastSink: string | null }> {
  const anchors = (await db().query("SELECT seq::int AS seq, hash, sink FROM audit_anchors ORDER BY seq")).rows as Array<{ seq: number; hash: string; sink: string }>;
  if (!anchors.length) return { checked: 0, mismatched: [], lastSink: null };
  const live = (await db().query("SELECT seq::int AS seq, hash FROM audit_log WHERE seq = ANY($1::bigint[])", [anchors.map((x) => x.seq)])).rows as Array<{ seq: number; hash: string }>;
  const bySeq = new Map(live.map((r) => [r.seq, r.hash]));
  return { checked: anchors.length, mismatched: mismatchedAnchors(anchors, (s) => bySeq.get(s)), lastSink: anchors[anchors.length - 1].sink };
}
