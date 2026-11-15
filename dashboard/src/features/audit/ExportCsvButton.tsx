"use client";

import { Download } from "lucide-react";

import { Button } from "@/components/ui/Button";
import type { AuditRow } from "./audit-rows";

function csvCell(value: string | number | null) {
  const text = value === null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Downloads the audit trail as CSV, one row per onchain event. */
export function ExportCsvButton({ rows }: { rows: readonly AuditRow[] }) {
  const onExport = () => {
    const header = ["time_utc", "block", "event", "intent", "status", "reason", "summary", "tx_hash"];
    const lines = rows.map((row) =>
      [row.at, row.blockNumber, row.event, row.intentId, row.status, row.reason, row.summary, row.txHash]
        .map(csvCell)
        .join(","),
    );
    const blob = new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "mandate-audit.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Button
      variant="secondary"
      icon={<Download aria-hidden />}
      onClick={onExport}
      disabled={rows.length === 0}
    >
      Export CSV
    </Button>
  );
}
