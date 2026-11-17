import { type ReactNode, useId } from "react";

import { cx } from "@/lib/cx";

import styles from "./Table.module.css";

export interface Column<Row> {
  key: string;
  header: string;
  cell: (row: Row) => ReactNode;
  align?: "start" | "end";
  nowrap?: boolean;
  /**
   * "primary" leads each stacked record on narrow screens (no label, full width).
   * "actions" holds row buttons and drops its label when stacked.
   */
  role?: "primary" | "actions";
  /** Shown only in Advanced view: hashes, block numbers, raw identifiers. See `useAdvancedColumns`. */
  advanced?: boolean;
}

export interface TableProps<Row> {
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  /** An element id for a row, so other pages can link straight to it. */
  rowId?: (row: Row) => string;
  /** Every table is named; hide the caption visually when a card title already says it. */
  caption: string;
  captionHidden?: boolean;
  /** "attention" highlights a row that needs the owner; "muted" recedes it. */
  rowTone?: (row: Row) => "attention" | "muted" | undefined;
  /** Rendered in place of the body when there are no rows. */
  empty?: ReactNode;
  className?: string;
}

/**
 * A semantic data table: fixed columns, tabular figures, and a stacked layout when its container
 * is narrow. State restyles a row; it never changes the columns.
 */
export function Table<Row>({
  columns,
  rows,
  rowKey,
  caption,
  captionHidden = false,
  rowTone,
  rowId,
  empty,
  className,
}: TableProps<Row>) {
  const captionId = useId();
  if (rows.length === 0 && empty !== undefined) {
    return <div className={styles.empty}>{empty}</div>;
  }
  return (
    <div className={cx(styles.wrap, className)} role="region" aria-labelledby={captionId} tabIndex={0}>
      <table className={styles.table}>
        <caption id={captionId} className={captionHidden ? "visually-hidden" : styles.caption}>
          {caption}
        </caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cx(styles.th, column.align === "end" && styles.end)}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const tone = rowTone?.(row);
            return (
              <tr key={rowKey(row)} id={rowId?.(row)} className={cx(styles.row, tone && styles[tone])}>
                {columns.map((column) => (
                  <td
                    key={column.key}
                    data-label={column.header}
                    className={cx(
                      styles.td,
                      column.align === "end" && styles.end,
                      column.nowrap && styles.nowrap,
                      column.role && styles[column.role],
                    )}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
