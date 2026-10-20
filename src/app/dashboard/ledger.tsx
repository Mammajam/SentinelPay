"use client";

import { useMemo, useRef, useState } from "react";
import type { AgGridReact } from "ag-grid-react";
import type { ColDef } from "ag-grid-community";
import { DataGrid, getJson, useApi } from "./hooks.tsx";
import { GridToolbar } from "../grid-toolbar.tsx";
import { formatMinor, mergeByKey } from "@/lib/ui/rows.ts";
import type { LedgerRow, LedgerTotal } from "./types.ts";

interface Page { rows: LedgerRow[]; nextBefore: number | null; summary?: LedgerTotal[] }

const DEFAULT_SORT = { colId: "at", sort: "desc" as const };
const cols: ColDef<LedgerRow>[] = [
  { field: "at", headerName: "When", minWidth: 190, valueFormatter: (p) => (p.value ? new Date(p.value).toLocaleString() : ""), comparator: (a, b) => Date.parse(a) - Date.parse(b) },
  { field: "captureId", headerName: "Capture", minWidth: 190, cellClass: "sp-mono" },
  { headerName: "Policy", colId: "policy", maxWidth: 140, cellClass: "sp-mono", valueGetter: (p) => p.data?.policyId?.slice(0, 8) ?? "" },
  { field: "amount", headerName: "Amount", maxWidth: 170, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: (p) => formatMinor(Number(p.value ?? 0), p.data?.currency ?? "USD") },
  { field: "currency", headerName: "Cur", maxWidth: 90 },
];

export function LedgerTab() {
  const [tick, setTick] = useState(0);
  const first = useApi<Page>("/api/admin/ledger?limit=50", tick);
  const [more, setMore] = useState<LedgerRow[]>([]);
  const [next, setNext] = useState<number | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const [quick, setQuick] = useState("");
  const gridRef = useRef<AgGridReact<LedgerRow>>(null);
  const cursor = next === undefined ? (first.data?.nextBefore ?? null) : next;
  const rows = useMemo(() => mergeByKey([...(first.data?.rows ?? []), ...more], (r) => r.id, (a, b) => b.id - a.id), [first.data, more]);
  const summary = useMemo(() => first.data?.summary ?? [], [first.data]);
  // Pinned totals come from the SERVER (all captures), not just the rows loaded so far.
  const pinned = useMemo<LedgerRow[]>(() => summary.map((s) => ({ id: -1, policyId: "", captureId: `TOTAL · ${s.count} capture${s.count === 1 ? "" : "s"}`, amount: s.total, currency: s.currency, at: "" })), [summary]);

  async function loadOlder() {
    if (!cursor) return;
    try {
      const d = await getJson<Page>(`/api/admin/ledger?limit=50&before=${cursor}`);
      setMore((m) => [...m, ...d.rows]);
      setNext(d.nextBefore);
    } catch (e) { setErr((e as Error).message); }
  }

  const error = err ?? first.error ?? null;
  return (
    <section>
      <p className="mb-2 text-xs text-neutral-600">Payments SentinelPay authorized and PayPal confirmed as captured (recorded from signed webhooks, once per capture id). Amounts are exact integer cents.</p>
      {summary.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-3">
          {summary.map((s) => (
            <div key={s.currency} className="rounded border px-3 py-2 text-sm">
              <div className="text-xs text-neutral-500">Total captured ({s.currency})</div>
              <div className="text-lg font-semibold">{formatMinor(s.total, s.currency)}</div>
              <div className="text-xs text-neutral-500">{s.count} capture{s.count === 1 ? "" : "s"}</div>
            </div>
          ))}
        </div>
      )}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <GridToolbar gridRef={gridRef} fileName="sentinel-ledger.csv" quick={quick} onQuick={setQuick} stateKey="ledger" defaultSort={DEFAULT_SORT} count={rows.length}>
        {cursor && <button className="rounded border px-2 py-1" onClick={loadOlder}>Load older</button>}
        <button className="rounded border px-2 py-1" onClick={() => { setMore([]); setNext(undefined); setTick((t) => t + 1); }}>Refresh</button>
      </GridToolbar>
      <DataGrid<LedgerRow>
        gridRef={gridRef}
        rows={rows}
        columns={cols}
        getRowId={(p) => String(p.data.id)}
        pinnedBottomRows={pinned}
        loading={!first.data && !error}
        emptyText="No captured payments yet."
        quickFilter={quick}
        stateKey="ledger"
        defaultSort={DEFAULT_SORT}
        ariaLabel="Captured payments"
      />
    </section>
  );
}
