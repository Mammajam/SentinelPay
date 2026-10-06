import { createHash } from "node:crypto";
import { canonicalize } from "../policy/readback.ts";

export const GENESIS = "0".repeat(64);

export interface AuditEntry {
  seq: number;
  prevHash: string;
  hash: string;
  kind: string;
  payload: unknown;
  at: string; // ISO timestamp, part of the hashed content
}

export const entryHash = (prevHash: string, kind: string, payload: unknown, at: string) =>
  createHash("sha256").update(`${prevHash}|${kind}|${at}|${canonicalize(payload)}`).digest("hex");

export function makeEntry(prev: AuditEntry | null, kind: string, payload: unknown, at = new Date().toISOString()): AuditEntry {
  const prevHash = prev?.hash ?? GENESIS;
  return { seq: (prev?.seq ?? 0) + 1, prevHash, hash: entryHash(prevHash, kind, payload, at), kind, payload, at };
}

/** Returns the seq of the first broken entry, or null if the chain is intact. */
export function verifyChain(entries: AuditEntry[]): number | null {
  let prev = GENESIS;
  for (const [i, e] of entries.entries()) {
    if (e.seq !== i + 1 || e.prevHash !== prev || e.hash !== entryHash(prev, e.kind, e.payload, e.at)) return e.seq;
    prev = e.hash;
  }
  return null;
}
