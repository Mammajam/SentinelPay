"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams, RowClassRules } from "ag-grid-community";
import { DataGrid, badge, getJson, useApi } from "./hooks.tsx";
import { GridToolbar } from "../grid-toolbar.tsx";
import { isHotAudit, mergeByKey } from "@/lib/ui/rows.ts";
import { TENANT_KINDS } from "@/lib/audit/view.ts";
import type { AuditRow } from "./types.ts";

interface Page { rows: AuditRow[]; nextCursor: string | null }

const DEFAULT_SORT = { colId: "at", sort: "desc" as const };
const cols: ColDef<AuditRow>[] = [
  { field: "at", headerName: "When", minWidth: 190, valueFormatter: (p) => new Date(p.value).toLocaleString(), comparator: (a, b) => Date.parse(a) - Date.parse(b) },
  { field: "kind", headerName: "Event", minWidth: 190, cellRenderer: (p: ICellRendererParams<AuditRow>) => badge(p.data?.tone ?? "info", String(p.value)) },
  { field: "summary", headerName: "What happened", flex: 3, minWidth: 280 },
  { field: "hash12", headerName: "Entry hash", maxWidth: 160, cellClass: "sp-mono" },
  { field: "selfHashOk", headerName: "Intact", maxWidth: 110, cellRenderer: (p: ICellRendererParams<AuditRow>) => (p.value ? <span title="This entry still hashes to its stored hash">✓</span> : <strong title="Hash mismatch: this entry was altered">✗ ALTERED</strong>) },
];
const rowRules: RowClassRules<AuditRow> = { "sp-row-hot": (p) => (p.data ? isHotAudit(p.data) : false) };
const compare = (a: AuditRow, b: AuditRow) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1); // newest first, stable

function Rows({ kind, live, quick, onQuick }: { kind: string; live: boolean; quick: string; onQuick: (v: string) => void }) {
  const base = new URLSearchParams({ limit: "50", ...(kind ? { kind } : {}) });
  const firstUrl = `/api/admin/audit?${base}`;
  const first = useApi<Page>(firstUrl);
  const [more, setMore] = useState<AuditRow[]>([]);
  const [fresh, setFresh] = useState<AuditRow[]>([]);
  const [next, setNext] = useState<string | null | undefined>(undefined); // undefined => first page's cursor
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<AuditRow | null>(null);
  const gridRef = useRef<AgGridReact<AuditRow>>(null);
  const cursor = next === undefined ? (first.data?.nextCursor ?? null) : next;
  const rows = useMemo(() => mergeByKey([...(first.data?.rows ?? []), ...more, ...fresh], (r) => r.id, compare), [first.data, more, fresh]);

  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => {
      getJson<Page>(firstUrl).then((d) => setFresh(d.rows), () => { /* transient */ });
    }, 5000);
    return () => clearInterval(t);
  }, [live, firstUrl]);

  async function loadOlder() {
    if (!cursor) return;
    try {
      const q = new URLSearchParams({ limit: "50", cursor, ...(kind ? { kind } : {}) });
      const d = await getJson<Page>(`/api/admin/audit?${q}`);
      setMore((m) => [...m, ...d.rows]);
      setNext(d.nextCursor);
    } catch (e) { setErr((e as Error).message); }
  }

  const error = err ?? first.error ?? null;
  return (
    <>
      {error && <p role="alert" className="text-sm sp-badge-bad rounded-lg px-3 py-2">{error}</p>}
      <GridToolbar gridRef={gridRef} fileName="sentinel-audit.csv" quick={quick} onQuick={onQuick} stateKey="audit" defaultSort={DEFAULT_SORT} count={rows.length}>
        {cursor && <button className="sp-btn" onClick={loadOlder}>Load older</button>}
      </GridToolbar>
      <DataGrid<AuditRow>
        gridRef={gridRef}
        rows={rows}
        columns={cols}
        getRowId={(p) => p.data.id}
        rowClassRules={rowRules}
        loading={!first.data && !error}
        emptyText="No audit entries for your tenant yet."
        pageSize={25}
        quickFilter={quick}
        stateKey="audit"
        defaultSort={DEFAULT_SORT}
        ariaLabel="Audit log"
        onRowClicked={setSelected}
      />
      {selected && (
        <article className="sp-card mt-3 p-4 text-sm" aria-label="Audit entry detail">
          <div className="flex items-center justify-between">
            <span><b>{selected.kind}</b> · {new Date(selected.at).toLocaleString()}</span>
            <button className="sp-link" onClick={() => setSelected(null)}>Close</button>
          </div>
          <p className="mt-1 text-xs sp-muted">Entry hash <span className="sp-mono">{selected.id}</span> · {selected.selfHashOk ? "re-hashes to its stored hash (intact)" : "DOES NOT re-hash: altered"}</p>
          <pre className="mt-2 max-h-64 overflow-auto sp-card-flat p-3 text-xs sp-mono">{selected.payload}</pre>
        </article>
      )}
    </>
  );
}

export function AuditTab() {
  const [kind, setKind] = useState("");
  const [tick, setTick] = useState(0);
  const [live, setLive] = useState(false);
  const [quick, setQuick] = useState("");
  return (
    <section>
      <p className="mb-2 text-xs sp-muted">Tamper-evident record of what happened in your tenant. Each entry is hash-chained to the one before it and re-checked here; the full chain and its external anchors are verified in the header.</p>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <label htmlFor="ak">Event</label>
        <select id="ak" className="sp-select" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">All</option>
          {TENANT_KINDS.map((k) => <option key={k}>{k}</option>)}
        </select>
        <label className="ml-2 flex items-center gap-1"><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Live (every 5 s)</label>
        <button className="sp-btn ml-auto" onClick={() => setTick((t) => t + 1)}>Refresh</button>
      </div>
      <Rows key={`${kind}-${tick}`} kind={kind} live={live} quick={quick} onQuick={setQuick} />
    </section>
  );
}
