"use client";

import { useState } from "react";
import { DecisionsTab } from "./dashboard/decisions.tsx";
import { PoliciesTab } from "./dashboard/policies.tsx";
import { ExceptionsTab } from "./dashboard/exceptions.tsx";
import { AuditTab } from "./dashboard/audit.tsx";
import { LedgerTab } from "./dashboard/ledger.tsx";
import { AccessTab } from "./dashboard/access.tsx";

const TABS = [
  ["decisions", "Decisions"],
  ["policies", "Policies"],
  ["exceptions", "Exceptions"],
  ["audit", "Audit"],
  ["ledger", "Ledger"],
  ["access", "Access"],
] as const;
type TabId = (typeof TABS)[number][0];

/** Dashboard shell: one tab per concern; each tab lives in src/app/dashboard/*.tsx and renders an AG Grid. */
export function DashboardClient() {
  const [tab, setTab] = useState<TabId>("decisions");
  return (
    <div className="mt-8">
      <div role="tablist" className="sp-tabs mb-5">
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className="sp-tab">{label}</button>
        ))}
      </div>
      {tab === "decisions" && <DecisionsTab />}
      {tab === "policies" && <PoliciesTab />}
      {tab === "exceptions" && <ExceptionsTab />}
      {tab === "audit" && <AuditTab />}
      {tab === "ledger" && <LedgerTab />}
      {tab === "access" && <AccessTab />}
    </div>
  );
}
