"use client";

import type { ReactNode, RefObject } from "react";
import type { AgGridReact } from "ag-grid-react";
import { csvSafe } from "@/lib/ui/rows.ts";
import { clearState, type DefaultSort } from "@/lib/ui/grid-state.ts";

/**
 * Shared toolbar for every grid: quick filter, row count, CSV export, reset layout.
 * Exports always go through csvSafe: cart ids, SKUs, summaries and merchant strings can be AGENT-controlled, and a cell
 * starting with = + - @ would run as a formula when the file is opened in a spreadsheet.
 */
export function GridToolbar<T>({ gridRef, fileName, quick, onQuick, stateKey, defaultSort, count, children }: {
  gridRef: RefObject<AgGridReact<T> | null>;
  fileName: string;
  quick: string;
  onQuick: (v: string) => void;
  stateKey?: string;
  defaultSort?: DefaultSort;
  count: number;
  children?: ReactNode;
}) {
  const exportCsv = () =>
    gridRef.current?.api.exportDataAsCsv({
      fileName,
      processCellCallback: (p) => csvSafe(p.formatValue ? p.formatValue(p.value) : p.value),
    });
  const reset = () => {
    gridRef.current?.api.resetColumnState();
    if (defaultSort) gridRef.current?.api.applyColumnState({ state: [{ colId: defaultSort.colId, sort: defaultSort.sort }], defaultState: { sort: null } });
    gridRef.current?.api.setFilterModel(null);
    onQuick("");
    if (stateKey) { try { clearState(stateKey, window.localStorage); } catch { /* storage unavailable */ } }
  };
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
      <input
        type="search"
        aria-label="Quick filter"
        placeholder="Quick filter…"
        className="sp-input w-56"
        value={quick}
        onChange={(e) => onQuick(e.target.value)}
      />
      <span className="sp-muted text-xs">{count} row{count === 1 ? "" : "s"} loaded</span>
      {children}
      <span className="ml-auto flex gap-2">
        <button className="sp-btn" onClick={reset}>Reset layout</button>
        <button className="sp-btn sp-btn-primary" onClick={exportCsv} disabled={count === 0}>Export CSV</button>
      </span>
    </div>
  );
}
