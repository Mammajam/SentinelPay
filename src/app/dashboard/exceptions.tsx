"use client";

import { useMemo, useRef, useState } from "react";
import type { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams, RowClassRules } from "ag-grid-community";
import { DataGrid, SecureAction, useApi } from "./hooks.tsx";
import { GridToolbar } from "../grid-toolbar.tsx";
import type { ExceptionView } from "./types.ts";

const rowRules: RowClassRules<ExceptionView> = { "sp-row-hot": (p) => Boolean(p.data?.ambiguous) };

export function ExceptionsTab() {
  const [tick, setTick] = useState(0);
  const res = useApi<{ exceptions: ExceptionView[] }>("/api/admin/exceptions", tick);
  const items = useMemo(() => res.data?.exceptions ?? [], [res.data]);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [quick, setQuick] = useState("");
  const gridRef = useRef<AgGridReact<ExceptionView>>(null);
  const msg = note ?? res.error ?? null;
  const selected = items.find((i) => i.orderId === open);

  const cols = useMemo<ColDef<ExceptionView>[]>(() => [
    { field: "orderId", headerName: "Order", minWidth: 170, cellClass: "font-mono" },
    { headerName: "Issue", colId: "issue", minWidth: 200, valueGetter: (p) => `${p.data?.issue ?? "—"} (${p.data?.actionType ?? ""})` },
    { headerName: "Outcome known?", colId: "outcome", minWidth: 200, valueGetter: (p) => (p.data?.ambiguous ? "UNKNOWN — reconcile first" : "Definitely failed") },
    { field: "attempt", headerName: "Attempt", maxWidth: 120, filter: "agNumberColumnFilter" },
    { field: "at", headerName: "When", minWidth: 190, valueFormatter: (p) => new Date(p.value).toLocaleString(), comparator: (a, b) => Date.parse(a) - Date.parse(b) },
    { headerName: "", colId: "action", sortable: false, filter: false, maxWidth: 150, cellRenderer: (p: ICellRendererParams<ExceptionView>) => (
      <button className="rounded border px-2 text-xs" onClick={() => setOpen(p.data?.orderId ?? null)}>Re-trigger…</button>
    ) },
  ], []);

  async function retrigger(x: ExceptionView, key: string, totp: string) {
    setBusy(true); setNote(null);
    const r = await fetch("/api/admin/captures/retrigger", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "x-sentinel-totp": totp }, body: JSON.stringify({ orderId: x.orderId, policyId: x.policyId }) });
    const j = (await r.json().catch(() => ({}))) as { status?: string; error?: string; paypalStatus?: string; decision?: string };
    setBusy(false);
    setNote(r.ok ? `Captured ${x.orderId}.` : `Not captured: ${j.error ?? j.status ?? r.status}${j.paypalStatus ? ` (PayPal says ${j.paypalStatus})` : ""}${j.decision ? ` (policy: ${j.decision})` : ""}.`);
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
      <GridToolbar gridRef={gridRef} fileName="sentinel-exceptions.csv" quick={quick} onQuick={setQuick} stateKey="exceptions" count={items.length} />
      <DataGrid<ExceptionView>
        gridRef={gridRef}
        rows={items}
        columns={cols}
        getRowId={(p) => p.data.orderId}
        rowClassRules={rowRules}
        loading={!res.data && !res.error}
        emptyText="No open capture failures."
        pageSize={10}
        quickFilter={quick}
        stateKey="exceptions"
        ariaLabel="Failed captures"
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
