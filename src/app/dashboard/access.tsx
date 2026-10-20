"use client";

import { useMemo, useRef, useState } from "react";
import type { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { DataGrid, badge, useApi } from "./hooks.tsx";
import { GridToolbar } from "../grid-toolbar.tsx";
import type { KeyRow, MerchantRow } from "./types.ts";

const DEFAULT_SORT = { colId: "createdAt", sort: "desc" as const };
const when = (p: { value?: string | null }) => (p.value ? new Date(p.value).toLocaleString() : "—");
const keyCols: ColDef<KeyRow>[] = [
  { field: "label", headerName: "Label", minWidth: 160 },
  { field: "role", headerName: "Role", maxWidth: 110 },
  { field: "prefix", headerName: "Key prefix", maxWidth: 160, cellClass: "sp-mono" },
  { field: "status", headerName: "Status", maxWidth: 130, cellRenderer: (p: ICellRendererParams<KeyRow>) => badge(String(p.value), String(p.value)) },
  { field: "createdAt", headerName: "Created", minWidth: 180, valueFormatter: when, comparator: (a, b) => Date.parse(a) - Date.parse(b) },
  { field: "expiresAt", headerName: "Expires", minWidth: 180, valueFormatter: when },
  { field: "lastUsedAt", headerName: "Last used", minWidth: 180, valueFormatter: when },
];
const merchantCols: ColDef<MerchantRow>[] = [{ field: "merchantId", headerName: "Registered PayPal merchant id", cellClass: "sp-mono", minWidth: 260 }];

/** Read-only view of who/what can act for this tenant. No secrets, no hashes. Revoke and rotate stay in the CLI on purpose. */
export function AccessTab() {
  const keys = useApi<{ keys: KeyRow[] }>("/api/admin/keys");
  const merchants = useApi<{ merchants: MerchantRow[] }>("/api/admin/merchants");
  const keyRows = useMemo(() => keys.data?.keys ?? [], [keys.data]);
  const merchantRows = useMemo(() => merchants.data?.merchants ?? [], [merchants.data]);
  const [quickK, setQuickK] = useState("");
  const [quickM, setQuickM] = useState("");
  const keyRef = useRef<AgGridReact<KeyRow>>(null);
  const merRef = useRef<AgGridReact<MerchantRow>>(null);

  return (
    <section className="space-y-6">
      <div>
        <h2 className="mb-1 font-medium">API keys</h2>
        <p className="mb-2 text-xs text-neutral-600">Only the identifying prefix is shown; keys and their hashes are never displayed. To revoke or rotate, use the operator CLI: <code>npm run admin -- revoke --tenant … --key-id …</code> / <code>rotate</code>.</p>
        <GridToolbar gridRef={keyRef} fileName="sentinel-keys.csv" quick={quickK} onQuick={setQuickK} stateKey="keys" defaultSort={DEFAULT_SORT} count={keyRows.length} />
        <DataGrid<KeyRow> gridRef={keyRef} rows={keyRows} columns={keyCols} getRowId={(p) => p.data.id} loading={!keys.data && !keys.error} emptyText="No keys." pageSize={10} quickFilter={quickK} stateKey="keys" defaultSort={DEFAULT_SORT} ariaLabel="API keys" />
      </div>
      <div>
        <h2 className="mb-1 font-medium">Registered merchants</h2>
        <p className="mb-2 text-xs text-neutral-600">A PayPal merchant belongs to exactly one tenant. Orders from any other merchant are denied under your policies. Add one with <code>npm run admin -- add-merchant</code>.</p>
        <GridToolbar gridRef={merRef} fileName="sentinel-merchants.csv" quick={quickM} onQuick={setQuickM} stateKey="merchants" count={merchantRows.length} />
        <DataGrid<MerchantRow> gridRef={merRef} rows={merchantRows} columns={merchantCols} getRowId={(p) => p.data.merchantId} loading={!merchants.data && !merchants.error} emptyText="No merchants registered." pageSize={10} quickFilter={quickM} stateKey="merchants" ariaLabel="Registered merchants" />
      </div>
    </section>
  );
}
