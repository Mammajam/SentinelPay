import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM envelope for secrets we must be able to read back (TOTP seeds).
 * Master key: SENTINEL_MASTER_KEY = base64 of 32 random bytes (`openssl rand -base64 32`).
 * In production load it from a secret manager (Vercel env / Google Secret Manager), not a file.
 * Fails closed: a missing or malformed key throws, it never "falls back" to plaintext.
 * Format: v1.<iv>.<tag>.<ciphertext>  (base64url). `aad` binds a ciphertext to its owner
 * (e.g. the api_keys row id) so a sealed value cannot be moved to another row.
 */
function masterKey(env: Record<string, string | undefined>): Buffer {
  const raw = env.SENTINEL_MASTER_KEY;
  if (!raw) throw new Error("SENTINEL_MASTER_KEY is not configured");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("SENTINEL_MASTER_KEY must be 32 bytes, base64-encoded");
  return key;
}

export function seal(plain: string, aad: string, env: Record<string, string | undefined> = process.env): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", masterKey(env), iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function open(sealed: string, aad: string, env: Record<string, string | undefined> = process.env): string {
  const [v, iv, tag, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("bad sealed value");
  const d = createDecipheriv("aes-256-gcm", masterKey(env), Buffer.from(iv, "base64url"));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}
