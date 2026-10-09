import { db } from "./client.ts";
import { appendAudit } from "./audit.ts";
import { anchorBody, buildGcsUpload, mismatchedAnchors, signAnchor, type Anchor } from "../audit/anchor.ts";

const isLocal = (h: string) => h === "localhost" || h === "127.0.0.1";

/** Access token for the Cloud Run service account via the metadata server (no keys on disk). */
async function metadataToken(): Promise<string> {
  const r = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
    headers: { "metadata-flavor": "Google" },
    signal: AbortSignal.timeout(3000),
  });
  if (!r.ok) throw new Error("metadata token unavailable");
  return ((await r.json()) as { access_token: string }).access_token;
}

/** Commit the current chain head. Sink priority: GCS bucket (ANCHOR_GCS_BUCKET) > signed HTTP (ANCHOR_SINK_URL) > DB only. */
export async function createAnchor(): Promise<{ seq: number; hash: string; sink: "db" | "http" | "gcs" } | null> {
  const { rows } = await db().query("SELECT seq::int AS seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1");
  if (!rows[0]) return null;
  const a: Anchor = { seq: rows[0].seq, hash: rows[0].hash, at: new Date().toISOString() };

  let sink: "db" | "http" | "gcs" = "db";
  let ref: string | null = null;
  const bucket = process.env.ANCHOR_GCS_BUCKET;
  const url = process.env.ANCHOR_SINK_URL;
  if (bucket) {
    const key = process.env.ANCHOR_HMAC_KEY;
    if (!key || key.length < 32) throw new Error("ANCHOR_HMAC_KEY (>=32 chars) required with ANCHOR_GCS_BUCKET");
    const up = buildGcsUpload(bucket, a, key);
    const res = await fetch(up.url, {
      method: "POST",
      headers: { authorization: `Bearer ${await metadataToken()}`, "content-type": "application/json" },
      body: up.body,
      signal: AbortSignal.timeout(10_000),
    });
    // 412 = this exact seq is already anchored (create-only): idempotent success.
    if (!res.ok && res.status !== 412) throw new Error(`gcs anchor rejected (${res.status})`);
    sink = "gcs";
    ref = `gs://${bucket}/${up.name}`;
  } else if (url) {
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
