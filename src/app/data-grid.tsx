"use client";

import { useSyncExternalStore, type Ref } from "react";
import { AgGridReact } from "ag-grid-react";
import { AllCommunityModule, ModuleRegistry, colorSchemeDark, colorSchemeLight, themeQuartz, type ColDef, type GetRowIdFunc, type RowClassRules } from "ag-grid-community";

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

export interface DataGridProps<T> {
  rows: T[];
  columns: ColDef<T>[];
  getRowId: GetRowIdFunc<T>;
  rowClassRules?: RowClassRules<T>;
  loading?: boolean;
  emptyText?: string;
  pageSize?: number;
  /** Receives the grid instance so callers can export CSV, etc. */
  gridRef?: Ref<AgGridReact<T>>;
}

/** Shared grid: sorting, column filters, resizing, pagination, a11y, and light/dark theme that follows the OS. */
export default function DataGrid<T>({ rows, columns, getRowId, rowClassRules, loading, emptyText = "Nothing to show.", pageSize = 25, gridRef }: DataGridProps<T>) {
  const dark = useSyncExternalStore(subscribe, prefersDark, () => false);
  return (
    <div className="w-full" data-testid="data-grid">
      <AgGridReact<T>
        ref={gridRef}
        theme={dark ? darkTheme : lightTheme}
        rowData={rows}
        columnDefs={columns}
        getRowId={getRowId}
        rowClassRules={rowClassRules}
        defaultColDef={{ sortable: true, filter: true, resizable: true, flex: 1, minWidth: 90 }}
        pagination
        paginationPageSize={pageSize}
        paginationPageSizeSelector={[10, 25, 50, 100]}
        domLayout="autoHeight"
        animateRows
        suppressCellFocus
        loading={loading}
        overlayNoRowsTemplate={`<span>${emptyText}</span>`}
      />
    </div>
  );
}
