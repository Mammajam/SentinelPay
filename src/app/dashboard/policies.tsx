"use client";

import { useMemo, useRef, useState } from "react";
import type { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { DataGrid, SecureAction, badge, useApi } from "./hooks.tsx";
import { GridToolbar } from "../grid-toolbar.tsx";
import type { PolicyView } from "./types.ts";

const DEFAULT_SORT = { colId: "createdAt", sort: "desc" as const };

/**
 * Grid for scanning/sorting/filtering many policies. The confirm/revoke flows stay in the detail panel below the
 * grid on purpose: the plain-language readback must read well, and those actions need key + one-time code.
 */
export function PoliciesTab() {
  const [tick, setTick] = useState(0);
  const res = useApi<{ policies: PolicyView[] }>("/api/admin/policies", tick);
  const items = useMemo(() => res.data?.policies ?? [], [res.data]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [action, setAction] = useState<"confirm" | "revoke" | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [quick, setQuick] = useState("");
  const gridRef = useRef<AgGridReact<PolicyView>>(null);
  const msg = note ?? res.error ?? null;
  const selected = items.find((p) => p.id === selectedId) ?? null;

  const cols = useMemo<ColDef<PolicyView>[]>(() => [
    { field: "status", headerName: "Status", maxWidth: 130, cellRenderer: (p: ICellRendererParams<PolicyView>) => badge(String(p.value), String(p.value)) },
    { field: "directive", headerName: "Directive", flex: 3, minWidth: 260 },
    { headerName: "Rules", colId: "rules", maxWidth: 110, filter: "agNumberColumnFilter", valueGetter: (p) => p.data?.rules.length ?? 0 },
    { field: "createdAt", headerName: "Created", minWidth: 190, valueFormatter: (p) => new Date(p.value).toLocaleString(), comparator: (a, b) => Date.parse(a) - Date.parse(b) },
    { headerName: "Hash", colId: "hash", maxWidth: 150, cellClass: "sp-mono", valueGetter: (p) => p.data?.hash.slice(0, 12) ?? "" },
    { headerName: "", colId: "review", sortable: false, filter: false, maxWidth: 120, cellRenderer: (p: ICellRendererParams<PolicyView>) => (
      <button className="rounded border px-2 text-xs" onClick={() => { setSelectedId(p.data?.id ?? null); setAction(null); }}>Review</button>
    ) },
  ], []);

  async function call(path: "/api/policies/confirm" | "/api/policies/revoke", p: PolicyView, key: string, totp: string) {
    setBusy(true); setNote(null);
    const body = path === "/api/policies/confirm" ? { id: p.id, hash: p.hash } : { id: p.id };
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "x-sentinel-totp": totp }, body: JSON.stringify(body) });
    setBusy(false);
    if (path === "/api/policies/confirm") setNote(r.ok ? `Policy ${p.id.slice(0, 8)} is now active.` : r.status === 409 ? "Not confirmed: hash mismatch, not a draft, or not your policy." : "Confirmation failed (check key and a fresh code).");
    else setNote(r.ok ? `Policy ${p.id.slice(0, 8)} revoked. No further orders can be authorized under it.` : "Revoke failed (check key and a fresh code).");
    if (r.ok) { setAction(null); setTick((t) => t + 1); }
  }

  return (
    <section className="space-y-3">
      {msg && <p role="status" className="text-sm">{msg}</p>}
      <GridToolbar gridRef={gridRef} fileName="sentinel-policies.csv" quick={quick} onQuick={setQuick} stateKey="policies" defaultSort={DEFAULT_SORT} count={items.length}>
        <button className="rounded border px-2 py-1" onClick={() => setTick((t) => t + 1)}>Refresh</button>
      </GridToolbar>
      <DataGrid<PolicyView>
        gridRef={gridRef}
        rows={items}
        columns={cols}
        getRowId={(p) => p.data.id}
        loading={!res.data && !res.error}
        emptyText="No policies yet. Compile one via the API."
        pageSize={10}
        quickFilter={quick}
        stateKey="policies"
        defaultSort={DEFAULT_SORT}
        ariaLabel="Policies"
        onRowClicked={(r) => { setSelectedId(r.id); setAction(null); }}
      />
      {selected && (
        <article className="rounded border p-3 text-sm" aria-label="Policy detail">
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs">{selected.id}</span>
            {badge(selected.status, selected.status)}
          </div>
          <p className="mt-1 text-neutral-600">“{selected.directive}”</p>
          <ul className="mt-2 list-disc pl-5">{selected.rules.map((r, i) => <li key={i}>{r}</li>)}</ul>
          <p className="mt-2 break-all font-mono text-[11px] text-neutral-500">sha256 {selected.hash}</p>
          {selected.status === "active" && (action === "revoke"
            ? <SecureAction label="Revoke policy" busy={busy} onSubmit={(k, t) => call("/api/policies/revoke", selected, k, t)} onCancel={() => setAction(null)} />
            : <button className="mt-2 rounded border border-red-600 px-3 py-1 text-xs text-red-600" onClick={() => setAction("revoke")}>Revoke…</button>)}
          {selected.status === "draft" && (action === "confirm"
            ? <SecureAction label="Confirm policy" busy={busy} onSubmit={(k, t) => call("/api/policies/confirm", selected, k, t)} onCancel={() => setAction(null)} />
            : <button className="mt-2 rounded border px-3 py-1 text-xs" onClick={() => setAction("confirm")}>Review &amp; confirm…</button>)}
        </article>
      )}
    </section>
  );
}
