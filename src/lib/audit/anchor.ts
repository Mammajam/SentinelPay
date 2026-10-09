import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Audit-chain anchoring (threat T11 / open item O4).
 * The chain head (seq, hash) is committed periodically. Anchors are written to an append-only
 * table AND, if ANCHOR_SINK_URL is set, POSTed to an external sink with an HMAC signature
 * (e.g. an object-lock bucket behind a small function). Re-verifying later proves nobody rewrote
 * history before that seq.
 *
 * HONEST LIMIT: the DB table alone protects against partial/naive tampering only. An attacker with
 * full DB superuser rights could rewrite both. Real protection needs the EXTERNAL sink.
 */
export interface Anchor { seq: number; hash: string; at: string }

export const anchorBody = (a: Anchor) => JSON.stringify({ seq: a.seq, hash: a.hash, at: a.at });

export const signAnchor = (a: Anchor, key: string) => createHmac("sha256", key).update(anchorBody(a)).digest("hex");

export function verifyAnchorSignature(a: Anchor, sig: string, key: string): boolean {
  const want = Buffer.from(signAnchor(a, key)), got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

/**
 * Compare stored anchors against the live chain. `chainHashAt(seq)` returns the hash currently
 * stored at that seq (or undefined). Returns the seqs whose anchored hash no longer matches.
 */
export function mismatchedAnchors(anchors: Array<{ seq: number; hash: string }>, chainHashAt: (seq: number) => string | undefined): number[] {
  return anchors.filter((a) => chainHashAt(a.seq) !== a.hash).map((a) => a.seq);
}

/**
 * Request to write one anchor as an IMMUTABLE-by-convention object in Google Cloud Storage
 * (`ifGenerationMatch=0` => create-only, never overwrite). With a (locked) bucket retention
 * policy even project owners cannot delete or replace it before the retention expires, which is
 * what makes this an external anchor rather than just another row in the same database.
 */
export function buildGcsUpload(bucket: string, a: Anchor, hmacKey: string) {
  const name = `anchors/${String(a.seq).padStart(12, "0")}-${a.hash.slice(0, 12)}.json`;
  return {
    name,
    url: `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&ifGenerationMatch=0&name=${encodeURIComponent(name)}`,
    body: JSON.stringify({ seq: a.seq, hash: a.hash, at: a.at, sig: signAnchor(a, hmacKey) }),
  };
}
