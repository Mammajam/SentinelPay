"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams, RowClassRules } from "ag-grid-community";
import { DataGrid, getJson, useApi } from "./hooks.tsx";
import { GridToolbar } from "../grid-toolbar.tsx";
import { isHotRow, mergeById } from "@/lib/ui/rows.ts";
import type { Decision } from "./types.ts";

// Defined once (stable references) so the grid does not rebuild its columns on every render.
const DEFAULT_SORT = { colId: "id", sort: "desc" as const };
const cols: ColDef<Decision>[] = [
  { field: "id", headerName: "#", maxWidth: 110, filter: "agNumberColumnFilter" },
  { field: "cartId", headerName: "Cart", minWidth: 150 },
  { field: "decision", headerName: "Decision", maxWidth: 200, cellRenderer: (p: ICellRendererParams<Decision>) => <span className={`sp-badge sp-badge-${p.value}`}>{p.value}</span> },
  { headerName: "Violations", colId: "violations", flex: 2, minWidth: 220, valueGetter: (p) => p.data?.violations.map((v) => v.code).join(", ") || "—" },
  { field: "at", headerName: "When", minWidth: 190, valueFormatter: (p) => new Date(p.value).toLocaleString(), comparator: (a, b) => Date.parse(a) - Date.parse(b) },
];
const rowRules: RowClassRules<Decision> = { "sp-row-hot": (p) => isHotRow(p.data?.violations) };

function Rows({ filter, live, quick, onQuick }: { filter: string; live: boolean; quick: string; onQuick: (v: string) => void }) {
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

  const error = err ?? first.error ?? null;
  return (
    <>
      {error && <p role="alert" className="text-sm sp-badge-bad rounded-lg px-3 py-2">{error}</p>}
      <GridToolbar gridRef={gridRef} fileName="sentinel-decisions.csv" quick={quick} onQuick={onQuick} stateKey="decisions" defaultSort={DEFAULT_SORT} count={rows.length}>
        {cursor && <button className="sp-btn" onClick={loadOlder}>Load older</button>}
      </GridToolbar>
      <DataGrid<Decision>
        gridRef={gridRef}
        rows={rows}
        columns={cols}
        getRowId={(p) => String(p.data.id)}
        rowClassRules={rowRules}
        loading={!first.data && !error}
        emptyText={`No decisions${filter ? ` with ${filter}` : ""} yet.`}
        quickFilter={quick}
        stateKey="decisions"
        defaultSort={DEFAULT_SORT}
        ariaLabel="Cart validation decisions"
      />
    </>
  );
}

export function DecisionsTab() {
  const [filter, setFilter] = useState("");
  const [tick, setTick] = useState(0);
  const [live, setLive] = useState(false);
  const [quick, setQuick] = useState("");
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <label htmlFor="df">Decision</label>
        <select id="df" className="sp-select" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">All</option><option>ALLOW</option><option>REQUIRE_REAUTH</option><option>DENY</option>
        </select>
        <label className="ml-2 flex items-center gap-1"><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Live (every 5 s)</label>
        <button className="sp-btn ml-auto" onClick={() => setTick((t) => t + 1)}>Refresh</button>
      </div>
      {/* keyed: changing the filter or refreshing resets pagination state cleanly */}
      <Rows key={`${filter}-${tick}`} filter={filter} live={live} quick={quick} onQuick={setQuick} />
    </section>
  );
}
