"use client";

import { Download } from "lucide-react";

import { Button } from "@/components/ui/Button";
import type { AuditRecord } from "@/lib/domain";

function csvCell(value: string | number | undefined) {
  const text = value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Downloads the records on screen as CSV, one row per onchain event. */
export function ExportCsvButton({ records }: { records: readonly AuditRecord[] }) {
  const onExport = () => {
    const header = ["time_utc", "block", "event", "intent", "status", "reason_code", "summary", "tx_hash"];
    const rows = records.map((record) =>
      [
        record.at,
        record.blockNumber,
        record.event,
        record.intentId,
        record.status,
        record.reasonCode,
        record.summary,
        record.txHash,
      ]
        .map(csvCell)
        .join(","),
    );
    const blob = new Blob([[header.join(","), ...rows].join("\n")], { type: "text/csv" });
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
      disabled={records.length === 0}
    >
      Export CSV
    </Button>
  );
}
