"use client";

import { useEffect, useState } from "react";

/* ---------- types mirrored from the read-only JSON APIs ---------- */
interface Violation { rule: string; code: string; message: string }
interface Decision { id: number; policyId: string; cartId: string; decision: "ALLOW" | "REQUIRE_REAUTH" | "DENY"; violations: Violation[]; at: string }
interface PolicyView { id: string; status: "draft" | "active" | "revoked"; hash: string; directive: string; rules: string[]; createdAt: string }
interface ExceptionView { orderId: string; policyId: string; issue: string | null; ambiguous: boolean; actionType: string; attempt: number; at: string }

const tone: Record<string, string> = {
  ALLOW: "text-emerald-700 bg-emerald-50",
  REQUIRE_REAUTH: "text-amber-700 bg-amber-50",
  DENY: "text-red-700 bg-red-50",
};
// Price surprises and integrity failures get a red row: these are the ones an operator must look at.
const RED = new Set(["PRICE_DRIFT", "BASELINE_UNKNOWN", "TOTAL_DOES_NOT_RECONCILE", "MERCHANT_NOT_REGISTERED", "MERCHANT_NOT_ALLOWED", "CURRENCY_MISMATCH"]);

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (r.status === 401) { window.location.reload(); throw new Error("session expired"); }
  if (!r.ok) throw new Error(`request failed (${r.status})`);
  return (await r.json()) as T;
}

/** Fetch-on-mount/update. State is set only inside promise callbacks (never synchronously in the effect). */
function useApi<T>(url: string, tick = 0) {
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  useEffect(() => {
    let cancelled = false;
    getJson<T>(url).then(
      (data) => { if (!cancelled) setState({ data }); },
      (e: Error) => { if (!cancelled) setState({ error: e.message }); },
    );
    return () => { cancelled = true; };
  }, [url, tick]);
  return state;
}

/** Asks for the admin key + one-time code at the moment of a sensitive action; never stores them. */
function SecureAction({ label, busy, onSubmit, onCancel }: { label: string; busy: boolean; onSubmit: (key: string, totp: string) => void; onCancel: () => void }) {
  const [key, setKey] = useState("");
  const [totp, setTotp] = useState("");
  return (
    <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); onSubmit(key, totp); setKey(""); setTotp(""); }}>
      <input className="w-64 rounded border px-2 py-1 text-xs" type="password" autoComplete="off" placeholder="Admin API key" value={key} onChange={(e) => setKey(e.target.value)} />
      <input className="w-28 rounded border px-2 py-1 text-xs" inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ""))} />
      <button disabled={busy || key.length < 10 || totp.length !== 6} className="rounded bg-black px-3 py-1 text-xs text-white disabled:opacity-40">{busy ? "Working…" : label}</button>
      <button type="button" onClick={onCancel} className="text-xs underline">Cancel</button>
    </form>
  );
}

/* ---------------------------- Decisions ---------------------------- */
function DecisionRows({ filter }: { filter: string }) {
  const qs = new URLSearchParams({ limit: "25", ...(filter ? { decision: filter } : {}) });
  const first = useApi<{ rows: Decision[]; nextBefore: number | null }>(`/api/admin/validations?${qs}`);
  const [more, setMore] = useState<Decision[]>([]);
  const [next, setNext] = useState<number | null | undefined>(undefined); // undefined => use the first page's cursor
  const [err, setErr] = useState<string | null>(null);
  const cursor = next === undefined ? (first.data?.nextBefore ?? null) : next;
  const rows = [...(first.data?.rows ?? []), ...more];

  async function loadMore() {
    if (!cursor) return;
    try {
      const q = new URLSearchParams({ limit: "25", before: String(cursor), ...(filter ? { decision: filter } : {}) });
      const d = await getJson<{ rows: Decision[]; nextBefore: number | null }>(`/api/admin/validations?${q}`);
      setMore((m) => [...m, ...d.rows]);
      setNext(d.nextBefore);
    } catch (e) { setErr((e as Error).message); }
  }

  const error = err ?? first.error ?? null;
  return (
    <>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <table className="w-full text-sm [&_td]:px-2 [&_td]:py-1.5 [&_th]:px-2 [&_th]:py-1">
        <thead><tr className="text-left text-neutral-500"><th>#</th><th>Cart</th><th>Decision</th><th>Violations</th><th>When</th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const hot = r.violations.some((v) => RED.has(v.code));
            return (
              <tr key={r.id} className={`border-t ${hot ? "bg-red-50 text-neutral-900 dark:bg-red-950 dark:text-red-100" : ""}`} data-hot={hot}>
                <td>{r.id}</td><td>{r.cartId}</td>
                <td><span className={`rounded px-2 py-0.5 ${tone[r.decision]}`}>{r.decision}</span></td>
                <td className={hot ? "font-medium text-red-700 dark:text-red-300" : ""}>{r.violations.map((v) => v.code).join(", ") || "—"}</td>
                <td>{new Date(r.at).toLocaleString()}</td>
              </tr>
            );
          })}
          {rows.length === 0 && !error && <tr><td colSpan={5} className="py-6 text-neutral-500">{first.data ? `No decisions${filter ? ` with ${filter}` : ""} yet.` : "Loading…"}</td></tr>}
        </tbody>
      </table>
      {cursor && <button className="mt-3 rounded border px-3 py-1 text-sm" onClick={loadMore}>Load more</button>}
    </>
  );
}

function DecisionsTab() {
  const [filter, setFilter] = useState("");
  const [tick, setTick] = useState(0);
  return (
    <section>
      <div className="mb-2 flex items-center gap-2 text-sm">
        <label htmlFor="df">Decision</label>
        <select id="df" className="rounded border px-2 py-1" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">All</option><option>ALLOW</option><option>REQUIRE_REAUTH</option><option>DENY</option>
        </select>
        <button className="ml-auto rounded border px-2 py-1" onClick={() => setTick((t) => t + 1)}>Refresh</button>
      </div>
      {/* keyed: changing the filter or refreshing resets pagination state cleanly */}
      <DecisionRows key={`${filter}-${tick}`} filter={filter} />
    </section>
  );
}

/* ----------------------------- Policies ----------------------------- */
function PoliciesTab() {
  const [tick, setTick] = useState(0);
  const res = useApi<{ policies: PolicyView[] }>("/api/admin/policies", tick);
  const items = res.data?.policies ?? [];
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const msg = note ?? res.error ?? null;
  const setMsg = setNote;

  async function confirm(p: PolicyView, key: string, totp: string) {
    setBusy(true); setMsg(null);
    const r = await fetch("/api/policies/confirm", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "x-sentinel-totp": totp }, body: JSON.stringify({ id: p.id, hash: p.hash }) });
    setBusy(false);
    setMsg(r.ok ? `Policy ${p.id.slice(0, 8)} is now active.` : r.status === 409 ? "Not confirmed: hash mismatch, not a draft, or not your policy." : "Confirmation failed (check key and a fresh code).");
    if (r.ok) { setOpen(null); setTick((t) => t + 1); }
  }

  return (
    <section className="space-y-3">
      {msg && <p role="status" className="text-sm">{msg}</p>}
      {!res.data && !res.error && <p className="py-6 text-sm text-neutral-500">Loading…</p>}
      {res.data && items.length === 0 && <p className="py-6 text-sm text-neutral-500">No policies yet. Compile one via the API.</p>}
      {items.map((p) => (
        <article key={p.id} className="rounded border p-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs">{p.id}</span>
            <span className={`rounded px-2 py-0.5 text-xs ${p.status === "active" ? "bg-emerald-50 text-emerald-700" : p.status === "draft" ? "bg-amber-50 text-amber-700" : "bg-neutral-100"}`}>{p.status}</span>
          </div>
          <p className="mt-1 text-neutral-600">“{p.directive}”</p>
          <ul className="mt-2 list-disc pl-5">{p.rules.map((r, i) => <li key={i}>{r}</li>)}</ul>
          <p className="mt-2 break-all font-mono text-[11px] text-neutral-500">sha256 {p.hash}</p>
          {p.status === "draft" && (open === p.id
            ? <SecureAction label="Confirm policy" busy={busy} onSubmit={(k, t) => confirm(p, k, t)} onCancel={() => setOpen(null)} />
            : <button className="mt-2 rounded border px-3 py-1 text-xs" onClick={() => setOpen(p.id)}>Review &amp; confirm…</button>)}
        </article>
      ))}
    </section>
  );
}

/* ---------------------------- Exceptions ---------------------------- */
function ExceptionsTab() {
  const [tick, setTick] = useState(0);
  const res = useApi<{ exceptions: ExceptionView[] }>("/api/admin/exceptions", tick);
  const items = res.data?.exceptions ?? [];
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const msg = note ?? res.error ?? null;
  const setMsg = setNote;

  async function retrigger(x: ExceptionView, key: string, totp: string) {
    setBusy(true); setMsg(null);
    const r = await fetch("/api/admin/captures/retrigger", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "x-sentinel-totp": totp }, body: JSON.stringify({ orderId: x.orderId, policyId: x.policyId }) });
    const j = (await r.json().catch(() => ({}))) as { status?: string; error?: string; paypalStatus?: string; decision?: string };
    setBusy(false);
    setMsg(r.ok ? `Captured ${x.orderId}.` : `Not captured: ${j.error ?? j.status ?? r.status}${j.paypalStatus ? ` (PayPal says ${j.paypalStatus})` : ""}${j.decision ? ` (policy: ${j.decision})` : ""}.`);
    setOpen(null);
    setTick((t) => t + 1);
  }

  return (
    <section>
      <p className="mb-2 text-xs text-neutral-600">Captures that failed and have not since succeeded. Re-triggering asks PayPal for the order&apos;s current state, re-checks your policy, and never double-charges.</p>
      {msg && <p role="status" className="mb-2 text-sm">{msg}</p>}
      <table className="w-full text-sm [&_td]:px-2 [&_td]:py-1.5 [&_th]:px-2 [&_th]:py-1">
        <thead><tr className="text-left text-neutral-500"><th>Order</th><th>Issue</th><th>Outcome known?</th><th>Attempt</th><th>When</th><th /></tr></thead>
        <tbody>
          {items.map((x) => (
            <tr key={x.orderId} className="border-t align-top">
              <td className="font-mono text-xs">{x.orderId}</td>
              <td>{x.issue ?? "—"} <span className="text-xs text-neutral-500">({x.actionType})</span></td>
              <td>{x.ambiguous ? <span className="rounded bg-amber-50 px-2 py-0.5 text-amber-700">UNKNOWN — reconcile first</span> : "Definitely failed"}</td>
              <td>{x.attempt}</td>
              <td>{new Date(x.at).toLocaleString()}</td>
              <td>
                {open === x.orderId
                  ? <SecureAction label="Re-trigger capture" busy={busy} onSubmit={(k, t) => retrigger(x, k, t)} onCancel={() => setOpen(null)} />
                  : <button className="rounded border px-2 py-1 text-xs" onClick={() => setOpen(x.orderId)}>Re-trigger…</button>}
              </td>
            </tr>
          ))}
          {items.length === 0 && <tr><td colSpan={6} className="py-6 text-neutral-500">{res.data ? "No open capture failures." : res.error ? "Could not load." : "Loading…"}</td></tr>}
        </tbody>
      </table>
    </section>
  );
}

/* ------------------------------- shell ------------------------------- */
export function DashboardClient() {
  const [tab, setTab] = useState<"decisions" | "policies" | "exceptions">("decisions");
  const tabs = [["decisions", "Decisions"], ["policies", "Policies"], ["exceptions", "Exceptions"]] as const;
  return (
    <div className="mt-6">
      <div role="tablist" className="mb-4 flex gap-1 border-b">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={`px-4 py-2 text-sm ${tab === id ? "border-b-2 border-black font-medium" : "text-neutral-500"}`}>{label}</button>
        ))}
      </div>
      {tab === "decisions" && <DecisionsTab />}
      {tab === "policies" && <PoliciesTab />}
      {tab === "exceptions" && <ExceptionsTab />}
    </div>
  );
}
