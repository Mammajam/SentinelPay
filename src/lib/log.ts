/**
 * Structured JSON logs (one object per line on stdout). Cloud Run / Cloud Logging parses
 * `severity` and `message` automatically, and every other field becomes queryable, so
 * log-based metrics (decisions by code, rejected webhooks, latency) need no extra agent.
 * Secrets are redacted by key name; never pass request bodies or credentials here.
 */
const SENSITIVE = /key|secret|token|authorization|password|totp|cookie|session|hash$/i;

export function redact(v: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth]";
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => redact(x, depth + 1));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SENSITIVE.test(k) ? "[redacted]" : redact(x, depth + 1)]));
  }
  return typeof v === "string" && v.length > 300 ? `${v.slice(0, 300)}…` : v;
}

export function log(severity: "INFO" | "WARNING" | "ERROR", event: string, fields: Record<string, unknown> = {}) {
  process.stdout.write(`${JSON.stringify({ severity, message: event, event, time: new Date().toISOString(), ...(redact(fields) as object) })}\n`);
}

/** Per-stage timing for hot paths: lap("auth") records ms since the previous lap. */
export function stopwatch() {
  let last = performance.now();
  const laps: Record<string, number> = {};
  return {
    laps,
    lap(name: string) {
      const now = performance.now();
      laps[name] = Math.round(now - last);
      last = now;
    },
  };
}
