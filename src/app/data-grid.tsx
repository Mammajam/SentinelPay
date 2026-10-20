"use client";

import { useSyncExternalStore, type Ref } from "react";
import { AgGridReact } from "ag-grid-react";
import { AllCommunityModule, ModuleRegistry, colorSchemeDark, colorSchemeLight, themeQuartz, type ColDef, type GetRowIdFunc, type GridApi, type RowClassRules } from "ag-grid-community";
import { loadState, saveState, type DefaultSort } from "@/lib/ui/grid-state.ts";

// AG Grid Community (MIT). Registered once at module load.
ModuleRegistry.registerModules([AllCommunityModule]);

const MEDIA = "(prefers-color-scheme: dark)";
function subscribe(cb: () => void) {
  const m = window.matchMedia(MEDIA);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}
const prefersDark = () => window.matchMedia(MEDIA).matches;

const lightTheme = themeQuartz.withPart(colorSchemeLight);
const darkTheme = themeQuartz.withPart(colorSchemeDark);

/** localStorage can throw (private windows, blocked site data): treat "unavailable" as "no saved layout". */
function storage(): Storage | undefined {
  try { return window.localStorage; } catch { return undefined; }
}

export interface DataGridProps<T> {
  rows: T[];
  columns: ColDef<T>[];
  getRowId: GetRowIdFunc<T>;
  rowClassRules?: RowClassRules<T>;
  loading?: boolean;
  emptyText?: string;
  pageSize?: number;
  /** Receives the grid instance so callers can export CSV, reset layout, etc. */
  gridRef?: Ref<AgGridReact<T>>;
  /** Free-text filter across all columns (AG Grid quick filter). */
  quickFilter?: string;
  /** When set, column order/width/visibility/sort are remembered in this browser under this key. */
  stateKey?: string;
  /** Pinned summary rows (e.g. totals), same shape as a data row. */
  pinnedBottomRows?: T[];
  /** Applied when there is no saved layout (instead of a per-column `sort`, so a restored layout never fights it). */
  defaultSort?: DefaultSort;
  ariaLabel?: string;
  onRowClicked?: (row: T) => void;
}

/** Shared grid: sorting, column filters, quick filter, resizing, pagination, persisted layout, a11y, light/dark theme that follows the OS. */
export default function DataGrid<T>({ rows, columns, getRowId, rowClassRules, loading, emptyText = "Nothing to show.", pageSize = 25, gridRef, quickFilter, stateKey, pinnedBottomRows, defaultSort, ariaLabel, onRowClicked }: DataGridProps<T>) {
  const dark = useSyncExternalStore(subscribe, prefersDark, () => false);
  const persist = (api: GridApi<T>) => { if (stateKey) saveState(stateKey, api.getColumnState(), storage()); };
  return (
    <div className="w-full" data-testid="data-grid" role="region" aria-label={ariaLabel}>
      <AgGridReact<T>
        ref={gridRef}
        theme={dark ? darkTheme : lightTheme}
        rowData={rows}
        columnDefs={columns}
        getRowId={getRowId}
        rowClassRules={rowClassRules}
        defaultColDef={{ sortable: true, filter: true, resizable: true, flex: 1, minWidth: 90 }}
        quickFilterText={quickFilter}
        pinnedBottomRowData={pinnedBottomRows}
        pagination
        paginationPageSize={pageSize}
        paginationPageSizeSelector={[10, 25, 50, 100]}
        domLayout="autoHeight"
        animateRows
        suppressCellFocus
        loading={loading}
        overlayNoRowsTemplate={`<span>${emptyText}</span>`}
        onGridReady={(e) => {
          const saved = stateKey ? loadState(stateKey, storage()) : null;
          // defaultState {sort:null} clears any other sort so exactly the saved (or default) sort is active.
          if (saved) e.api.applyColumnState({ state: saved, applyOrder: true, defaultState: { sort: null } });
          else if (defaultSort) e.api.applyColumnState({ state: [{ colId: defaultSort.colId, sort: defaultSort.sort }], defaultState: { sort: null } });
        }}
        onColumnResized={(e) => { if (e.finished) persist(e.api); }}
        onColumnMoved={(e) => { if (e.finished) persist(e.api); }}
        onColumnVisible={(e) => persist(e.api)}
        onSortChanged={(e) => persist(e.api)}
        onRowClicked={(e) => { if (e.data) onRowClicked?.(e.data); }}
      />
    </div>
  );
}
