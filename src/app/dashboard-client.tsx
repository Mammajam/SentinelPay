"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams, RowClassRules } from "ag-grid-community";
import dynamic from "next/dynamic";

// Client-only: AG Grid has no meaningful server render, and skipping it avoids a light-themed flash before hydration.
const DataGrid = dynamic(() => import("./data-grid.tsx"), {
  ssr: false,
  loading: () => <p className="py-6 text-sm text-neutral-500">Loading grid…</p>,
}) as typeof import("./data-grid.tsx").default;
import { csvSafe, isHotRow, mergeById } from "@/lib/ui/rows.ts";

/* ---------- types mirrored from the read-only JSON APIs ---------- */
interface Violation { rule: string; code: string; message: string }
interface Decision { id: number; policyId: string; cartId: string; decision: "ALLOW" | "REQUIRE_REAUTH" | "DENY"; violations: Violation[]; at: string }
interface PolicyView { id: string; status: "draft" | "active" | "revoked"; hash: string; directive: string; rules: string[]; createdAt: string }
interface ExceptionView { orderId: string; policyId: string; issue: string | null; ambiguous: boolean; actionType: string; attempt: number; at: string }

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
// Defined once (stable references) so the grid does not rebuild its columns on every render.
const decisionCols: ColDef<Decision>[] = [
  { field: "id", headerName: "#", maxWidth: 110, sort: "desc", filter: "agNumberColumnFilter" },
  { field: "cartId", headerName: "Cart", minWidth: 150 },
  { field: "decision", headerName: "Decision", maxWidth: 200, cellRenderer: (p: ICellRendererParams<Decision>) => <span className={`sp-badge sp-badge-${p.value}`}>{p.value}</span> },
  { headerName: "Violations", flex: 2, minWidth: 220, valueGetter: (p) => p.data?.violations.map((v) => v.code).join(", ") || "—" },
  { field: "at", headerName: "When", minWidth: 190, valueFormatter: (p) => new Date(p.value).toLocaleString(), comparator: (a, b) => Date.parse(a) - Date.parse(b) },
];
const decisionRowRules: RowClassRules<Decision> = { "sp-row-hot": (p) => isHotRow(p.data?.violations) };

function DecisionRows({ filter, live }: { filter: string; live: boolean }) {
  const qs = new URLSearchParams({ limit: "25", ...(filter ? { decision: filter } : {}) });
  const firstUrl = `/api/admin/validations?${qs}`;
  const first = useApi<{ rows: Decision[]; nextBefore: number | null }>(firstUrl);
  const [more, setMore] = useState<Decision[]>([]);
  const [fresh, setFresh] = useState<Decision[]>([]); // newest page, refreshed by live polling
  const [next, setNext] = useState<number | null | undefined>(undefined); // undefined => use the first page's cursor
  const [err, setErr] = useState<string | null>(null);
  const gridRef = useRef<AgGridReact<Decision>>(null);
  const cursor = next === undefined ? (first.data?.nextBefore ?? null) : next;
  const rows = useMemo(() => mergeById([...(first.data?.rows ?? []), ...more, ...fresh]), [first.data, more, fresh]);

  // Live mode: poll the newest page and MERGE (ids de-duplicated), so the operator keeps their sort, filter and page.
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => {
      getJson<{ rows: Decision[] }>(firstUrl).then((d) => setFresh(d.rows), () => { /* transient: next tick retries */ });
    }, 5000);
    return () => clearInterval(t);
  }, [live, firstUrl]);

  async function loadOlder() {
    if (!cursor) return;
    try {
      const q = new URLSearchParams({ limit: "25", before: String(cursor), ...(filter ? { decision: filter } : {}) });
      const d = await getJson<{ rows: Decision[]; nextBefore: number | null }>(`/api/admin/validations?${q}`);
      setMore((m) => [...m, ...d.rows]);
      setNext(d.nextBefore);
    } catch (e) { setErr((e as Error).message); }
  }

  const exportCsv = () =>
    gridRef.current?.api.exportDataAsCsv({
      fileName: "sentinelpay-decisions.csv",
      // Cart ids/SKUs are agent-controlled: neutralise spreadsheet formulas (=, +, -, @) in the exported file.
      processCellCallback: (p) => csvSafe(p.formatValue ? p.formatValue(p.value) : p.value),
    });

  const error = err ?? first.error ?? null;
  return (
    <>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <DataGrid<Decision>
        gridRef={gridRef}
        rows={rows}
        columns={decisionCols}
        getRowId={(p) => String(p.data.id)}
        rowClassRules={decisionRowRules}
        loading={!first.data && !error}
        emptyText={`No decisions${filter ? ` with ${filter}` : ""} yet.`}
      />
      <div className="mt-3 flex gap-2">
        {cursor && <button className="rounded border px-3 py-1 text-sm" onClick={loadOlder}>Load older</button>}
        <button className="rounded border px-3 py-1 text-sm" onClick={exportCsv} disabled={rows.length === 0}>Export CSV</button>
      </div>
    </>
  );
}

function DecisionsTab() {
  const [filter, setFilter] = useState("");
  const [tick, setTick] = useState(0);
  const [live, setLive] = useState(false);
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        <label htmlFor="df">Decision</label>
        <select id="df" className="rounded border px-2 py-1" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">All</option><option>ALLOW</option><option>REQUIRE_REAUTH</option><option>DENY</option>
        </select>
        <label className="ml-2 flex items-center gap-1"><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Live (every 5 s)</label>
        <button className="ml-auto rounded border px-2 py-1" onClick={() => setTick((t) => t + 1)}>Refresh</button>
      </div>
      {/* keyed: changing the filter or refreshing resets pagination state cleanly */}
      <DecisionRows key={`${filter}-${tick}`} filter={filter} live={live} />
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

  async function revoke(p: PolicyView, key: string, totp: string) {
    setBusy(true); setMsg(null);
    const r = await fetch("/api/policies/revoke", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "x-sentinel-totp": totp }, body: JSON.stringify({ id: p.id }) });
    setBusy(false);
    setMsg(r.ok ? `Policy ${p.id.slice(0, 8)} revoked. No further orders can be authorized under it.` : "Revoke failed (check key and a fresh code).");
    if (r.ok) { setOpen(null); setTick((t) => t + 1); }
  }

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
          {p.status === "active" && (open === `revoke:${p.id}`
            ? <SecureAction label="Revoke policy" busy={busy} onSubmit={(k, t) => revoke(p, k, t)} onCancel={() => setOpen(null)} />
            : <button className="mt-2 rounded border border-red-600 px-3 py-1 text-xs text-red-600" onClick={() => setOpen(`revoke:${p.id}`)}>Revoke…</button>)}
          {p.status === "draft" && (open === p.id
            ? <SecureAction label="Confirm policy" busy={busy} onSubmit={(k, t) => confirm(p, k, t)} onCancel={() => setOpen(null)} />
            : <button className="mt-2 rounded border px-3 py-1 text-xs" onClick={() => setOpen(p.id)}>Review &amp; confirm…</button>)}
        </article>
      ))}
    </section>
  );
}

/* ---------------------------- Exceptions ---------------------------- */
const exceptionRowRules: RowClassRules<ExceptionView> = { "sp-row-hot": (p) => Boolean(p.data?.ambiguous) };

function ExceptionsTab() {
  const [tick, setTick] = useState(0);
  const res = useApi<{ exceptions: ExceptionView[] }>("/api/admin/exceptions", tick);
  const items = useMemo(() => res.data?.exceptions ?? [], [res.data]);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const msg = note ?? res.error ?? null;
  const setMsg = setNote;
  const selected = items.find((i) => i.orderId === open);

  const cols = useMemo<ColDef<ExceptionView>[]>(() => [
    { field: "orderId", headerName: "Order", minWidth: 170, cellClass: "font-mono" },
    { headerName: "Issue", minWidth: 200, valueGetter: (p) => `${p.data?.issue ?? "—"} (${p.data?.actionType ?? ""})` },
    { headerName: "Outcome known?", minWidth: 200, valueGetter: (p) => (p.data?.ambiguous ? "UNKNOWN — reconcile first" : "Definitely failed") },
    { field: "attempt", headerName: "Attempt", maxWidth: 120, filter: "agNumberColumnFilter" },
    { field: "at", headerName: "When", minWidth: 190, valueFormatter: (p) => new Date(p.value).toLocaleString(), comparator: (a, b) => Date.parse(a) - Date.parse(b) },
    { headerName: "", colId: "action", sortable: false, filter: false, maxWidth: 150, cellRenderer: (p: ICellRendererParams<ExceptionView>) => (
      <button className="rounded border px-2 text-xs" onClick={() => setOpen(p.data?.orderId ?? null)}>Re-trigger…</button>
    ) },
  ], []);

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
      <div className="mb-2 flex items-center gap-2">
        <p className="text-xs text-neutral-600">Captures that failed and have not since succeeded. Re-triggering asks PayPal for the order&apos;s current state, re-checks your policy, and never double-charges. Highlighted rows have an UNKNOWN outcome: reconcile before retrying.</p>
        <button className="ml-auto rounded border px-2 py-1 text-sm" onClick={() => setTick((t) => t + 1)}>Refresh</button>
      </div>
      {msg && <p role="status" className="mb-2 text-sm">{msg}</p>}
      <DataGrid<ExceptionView>
        rows={items}
        columns={cols}
        getRowId={(p) => p.data.orderId}
        rowClassRules={exceptionRowRules}
        loading={!res.data && !res.error}
        emptyText="No open capture failures."
        pageSize={10}
      />
      {selected && (
        <div className="mt-3 rounded border p-3 text-sm">
          <p>Re-trigger capture for <span className="font-mono">{selected.orderId}</span> (attempt {selected.attempt}{selected.ambiguous ? ", outcome unknown: the same idempotency key is reused" : ""})</p>
          <SecureAction label="Re-trigger capture" busy={busy} onSubmit={(k, t) => retrigger(selected, k, t)} onCancel={() => setOpen(null)} />
        </div>
      )}
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
