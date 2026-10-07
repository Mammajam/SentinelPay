import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** RFC 6238 TOTP (HMAC-SHA1, 30 s step) — compatible with Google Authenticator, 1Password, Authy… */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, "").toUpperCase();
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(randomBytes(20));

export const stepAt = (now: Date, stepSec = 30) => Math.floor(now.getTime() / 1000 / stepSec);

/** The code for a given step. `secret` is base32. */
export function totpCode(secret: string, step: number, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const off = h[h.length - 1] & 0xf;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export type TotpResult = { ok: true; step: number } | { ok: false };

/**
 * Accepts the current step ±1 (clock skew). `lastUsedStep` makes a code single-use:
 * any step <= lastUsedStep is rejected, so a shoulder-surfed or intercepted code
 * cannot be replayed. The caller must persist `step` atomically (see keys.ts).
 */
export function verifyTotp(secret: string, code: string, now: Date, lastUsedStep: number, digits = 6): TotpResult {
  if (!/^\d+$/.test(code) || code.length !== digits) return { ok: false };
  const cur = stepAt(now);
  let hit = -1;
  for (const s of [cur - 1, cur, cur + 1]) {
    const expected = Buffer.from(totpCode(secret, s, digits));
    const given = Buffer.from(code);
    // evaluate every candidate (no early exit) to keep timing independent of which step matched
    if (expected.length === given.length && timingSafeEqual(expected, given) && s > lastUsedStep) hit = Math.max(hit, s);
  }
  return hit >= 0 ? { ok: true, step: hit } : { ok: false };
}

export const otpauthUri = (secret: string, account: string, issuer = "SentinelPay") =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;
