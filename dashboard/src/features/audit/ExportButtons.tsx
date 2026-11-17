"use client";

import { Braces, Download } from "lucide-react";

import { Button } from "@/components/ui/Button";

import styles from "./audit.module.css";

function download(name: string, type: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Downloads exactly the rows on screen, in the order shown, as CSV or JSON. The caller builds both
 * bodies from the same rows, so the two files and the table never disagree.
 */
export function ExportButtons({
  count,
  baseName,
  csv,
  json,
}: {
  count: number;
  baseName: string;
  csv: () => string;
  json: () => string;
}) {
  const what = `${count.toString()} ${count === 1 ? "row" : "rows"}`;
  return (
    <div className={styles.exports}>
      <Button
        variant="secondary"
        icon={<Download aria-hidden />}
        onClick={() => download(`${baseName}.csv`, "text/csv;charset=utf-8", csv())}
        disabled={count === 0}
        aria-label={`Export CSV, ${what}`}
      >
        Export CSV
      </Button>
      <Button
        variant="secondary"
        icon={<Braces aria-hidden />}
        onClick={() => download(`${baseName}.json`, "application/json", json())}
        disabled={count === 0}
        aria-label={`Export JSON, ${what}`}
      >
        Export JSON
      </Button>
    </div>
  );
}
