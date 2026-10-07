import { createVerify, createHash, timingSafeEqual } from "node:crypto";

/** CRC32 (IEEE) of the raw body as an unsigned 32-bit decimal, as PayPal's scheme requires. */
export function crc32(buf: Buffer): number {
  let c: number;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * PayPal only serves signing certs from its own hosts. An attacker-controlled
 * PAYPAL-CERT-URL would let them supply their own key and forge events, so the
 * URL MUST be validated before it is fetched.
 */
export function isTrustedCertUrl(raw: string, devOrigin?: string): boolean {
  try {
    const u = new URL(raw);
    // Dev-only escape hatch for the local PayPal simulator (see devCertOrigin()).
    if (devOrigin && u.origin === devOrigin && !u.username && u.pathname.startsWith("/v1/notifications/certs/")) return true;
    return (
      u.protocol === "https:" &&
      u.port === "" &&
      !u.username &&
      /^([a-z0-9-]+\.)*paypal\.com$/.test(u.hostname) &&
      u.pathname.startsWith("/v1/notifications/certs/")
    );
  } catch {
    return false;
  }
}

/**
 * Returns the simulator's cert origin ONLY when it is provably a local dev setup:
 * NODE_ENV is not production, PayPal base URL and cert origin are both loopback,
 * and the cert origin is plain http. Anything else => undefined (feature off).
 * This is what keeps the simulator from ever widening the trust boundary in prod.
 */
export function devCertOrigin(env: Record<string, string | undefined>): string | undefined {
  const raw = env.SIM_CERT_ORIGIN;
  if (!raw || env.NODE_ENV === "production") return undefined;
  try {
    const cert = new URL(raw);
    const base = new URL(env.PAYPAL_BASE_URL ?? "");
    const loopback = (h: string) => h === "localhost" || h === "127.0.0.1";
    if (cert.protocol !== "http:" || !loopback(cert.hostname) || !loopback(base.hostname)) return undefined;
    return cert.origin;
  } catch {
    return undefined;
  }
}

export interface WebhookHeaders {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export interface VerifyOptions {
  webhookId: string;
  /** Returns the PEM (certificate or public key) for a validated cert URL. Inject a cached fetcher. */
  fetchCertPem: (certUrl: string) => Promise<string>;
  now?: Date;
  maxSkewSec?: number;
  /** From devCertOrigin(); leave undefined everywhere except local simulator runs. */
  devCertOrigin?: string;
}

const ALGOS: Record<string, string> = { SHA256withRSA: "RSA-SHA256" };

/**
 * signed string = transmissionId | transmissionTime | webhookId | crc32(rawBody)
 * Signature is base64 RSA over that string. Fail-closed on every branch.
 * `rawBody` MUST be the exact bytes received (do not re-serialize JSON).
 */
export async function verifyWebhook(rawBody: Buffer, h: WebhookHeaders, o: VerifyOptions): Promise<VerifyResult> {
  const algo = ALGOS[h.authAlgo];
  if (!algo) return { ok: false, reason: "unsupported_algo" };
  if (!isTrustedCertUrl(h.certUrl, o.devCertOrigin)) return { ok: false, reason: "untrusted_cert_url" };

  const t = Date.parse(h.transmissionTime);
  const now = (o.now ?? new Date()).getTime();
  if (Number.isNaN(t) || Math.abs(now - t) > (o.maxSkewSec ?? 300) * 1000) return { ok: false, reason: "stale_or_bad_timestamp" };

  let pem: string;
  try {
    pem = await o.fetchCertPem(h.certUrl);
  } catch {
    return { ok: false, reason: "cert_fetch_failed" };
  }

  const signed = `${h.transmissionId}|${h.transmissionTime}|${o.webhookId}|${crc32(rawBody)}`;
  try {
    const ok = createVerify(algo).update(signed).verify(pem, h.transmissionSig, "base64");
    return ok ? { ok: true } : { ok: false, reason: "bad_signature" };
  } catch {
    return { ok: false, reason: "verify_error" };
  }
}

export const bodyDigest = (b: Buffer) => createHash("sha256").update(b).digest("hex");
export const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
