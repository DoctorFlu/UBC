"use client";

import { type ConsoleHolding, holdingQuantitySchema, holdingSchema } from "@mandate/shared";
import { CircleAlert, Plus, Save, Trash2 } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";
import { When } from "@/components/ui/When";
import { ownerBlockedReason } from "@/lib/owner/access";
import { useOwnerRequest } from "@/lib/owner/useOwnerRequest";
import { useHydrated } from "@/lib/useHydrated";

import styles from "./hedge.module.css";

interface Row {
  key: number;
  asset: string;
  quantity: string;
  note?: string;
}

type RowField = "asset" | "quantity";

// Keys come from the list itself, never from a module counter: the server and the browser must render
// the same element ids, or hydration fails.
const toRows = (holdings: readonly ConsoleHolding[]): Row[] =>
  holdings.map((holding, index) => ({ key: index + 1, ...holding }));
const nextKey = (rows: readonly Row[]) => Math.max(0, ...rows.map((row) => row.key)) + 1;
const signature = (rows: readonly Pick<Row, "asset" | "quantity">[]) =>
  JSON.stringify(rows.map((row) => [row.asset.trim().toUpperCase(), row.quantity.trim()]));
const fieldKey = (row: Row, field: RowField) => `${row.key.toString()}:${field}`;

type RowErrors = Partial<Record<RowField, string>>;

function validate(rows: readonly Row[]): RowErrors[] {
  const seen = new Set<string>();
  return rows.map((row) => {
    const errors: RowErrors = {};
    const asset = row.asset.trim().toUpperCase();
    if (!holdingSchema.shape.asset.safeParse(asset).success) errors.asset = "Use the ticker, like BTC.";
    else if (seen.has(asset)) errors.asset = `${asset} is already listed.`;
    seen.add(asset);
    if (!holdingQuantitySchema.safeParse(row.quantity.trim()).success) {
      errors.quantity = "Quantity: a number like 0.05, at most 8 decimals.";
    }
    return errors;
  });
}

/**
 * What the owner holds, which the agent reads (GET holdings) to size a hedge. Saving is an offchain
 * change signed by the owner's wallet, so nobody else can tell the agent what you own.
 *
 * A field's error shows only once it was edited or a save was attempted, never on a row just added.
 * Each row keeps one line for its message whether or not one shows, so nothing below it moves.
 */
export function HoldingsEditor({
  holdings,
  updatedAt,
}: {
  holdings: readonly ConsoleHolding[];
  updatedAt: string | null;
}) {
  const toast = useToast();
  const hydrated = useHydrated();
  const { request, pending, access } = useOwnerRequest();
  const blocked = ownerBlockedReason(access);
  const idBase = useId();
  const [rows, setRows] = useState(() => toRows(holdings));
  // Fields the owner edited, and whether a save was attempted: the only reasons to show an error.
  const [edited, setEdited] = useState<ReadonlySet<string>>(() => new Set());
  const [attempted, setAttempted] = useState(false);
  // When saved holdings change (here or in another tab), an untouched list follows them.
  const [baseline, setBaseline] = useState(holdings);
  if (baseline !== holdings && signature(baseline) !== signature(holdings)) {
    const untouched = signature(rows) === signature(baseline);
    setBaseline(holdings);
    if (untouched) setRows(toRows(holdings));
  }

  const errors = validate(rows);
  const valid = errors.every((error) => !error.asset && !error.quantity);
  const dirty = signature(rows) !== signature(holdings);
  const shown = (row: Row, index: number, field: RowField): string | undefined =>
    attempted || edited.has(fieldKey(row, field)) ? errors[index]?.[field] : undefined;

  const update = (row: Row, field: RowField, value: string) => {
    setRows((current) =>
      current.map((other) => (other.key === row.key ? { ...other, [field]: value } : other)),
    );
    setEdited((current) => new Set(current).add(fieldKey(row, field)));
  };

  const save = async () => {
    const payload = {
      holdings: rows.map((row) => ({
        asset: row.asset.trim().toUpperCase(),
        quantity: row.quantity.trim(),
        ...(row.note ? { note: row.note } : {}),
      })),
    };
    const result = await request("/api/console/holdings", "PUT", "holdings.save", payload);
    if (result.ok) {
      setAttempted(false);
      setEdited(new Set());
    }
    toast(
      result.ok
        ? {
            title: "Holdings saved",
            description: "The agent sizes its next hedge to these.",
            tone: "success",
          }
        : { title: "Not saved", description: result.message, tone: "danger" },
    );
  };

  return (
    <form
      className={styles.holdings}
      onSubmit={(event) => {
        event.preventDefault();
        if (!dirty) return;
        if (valid) void save();
        else setAttempted(true);
      }}
    >
      {rows.length === 0 ? (
        <p className={styles.muted}>
          Nothing listed. Add the BTC you want protected and the agent sizes a ladder to it.
        </p>
      ) : (
        <ul className={styles.holdingRows}>
          {rows.map((row, index) => {
            const asset = shown(row, index, "asset");
            const quantity = shown(row, index, "quantity");
            const message = asset ?? quantity;
            const messageId = `${idBase}-${row.key.toString()}-error`;
            return (
              <li key={row.key} className={styles.holdingRow} data-testid="holding-row">
                <Field label="Asset" invalid={asset !== undefined}>
                  <Input
                    aria-describedby={asset !== undefined ? messageId : undefined}
                    value={row.asset}
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={10}
                    onValueChange={(value) => update(row, "asset", value.toUpperCase())}
                  />
                </Field>
                <Field label="Quantity" invalid={quantity !== undefined}>
                  <Input
                    aria-describedby={quantity !== undefined ? messageId : undefined}
                    value={row.quantity}
                    inputMode="decimal"
                    autoComplete="off"
                    spellCheck={false}
                    onValueChange={(value) => update(row, "quantity", value)}
                  />
                </Field>
                <Button
                  variant="ghost"
                  iconOnly
                  className={styles.removeHolding}
                  aria-label={`Remove ${row.asset || "this row"}`}
                  icon={<Trash2 aria-hidden />}
                  onClick={() => setRows((current) => current.filter((other) => other.key !== row.key))}
                />
                {/* Always rendered, one line tall, so a message appearing never moves the buttons. */}
                <p id={messageId} className={styles.holdingError} aria-live="polite">
                  {message ? (
                    <>
                      <CircleAlert aria-hidden strokeWidth={2.25} />
                      <span>{message}</span>
                    </>
                  ) : null}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      <div className={styles.holdingActions}>
        <Button
          variant="ghost"
          icon={<Plus aria-hidden />}
          disabled={rows.length >= 20}
          onClick={() =>
            setRows((current) => [
              ...current,
              { key: nextKey(current), asset: current.length === 0 ? "BTC" : "", quantity: "" },
            ])
          }
        >
          Add an asset
        </Button>
        <Button
          type="submit"
          variant="primary"
          icon={<Save aria-hidden />}
          loading={pending}
          disabled={!hydrated || !dirty || blocked !== null}
        >
          Sign and save
        </Button>
      </div>
      {/* What the agent reads now, against what is only on this screen: edits count once signed and saved. */}
      <p className={styles.muted} data-testid="holdings-status" aria-live="polite">
        {blocked && access.kind !== "loading" && dirty ? (
          blocked
        ) : dirty ? (
          updatedAt ? (
            <>
              Not saved yet. The agent still reads the list saved <When inSentence at={updatedAt} date />.
            </>
          ) : (
            "Not saved yet."
          )
        ) : updatedAt ? (
          <>
            Saved <When inSentence at={updatedAt} date />. The agent reads this list.
          </>
        ) : (
          "Never saved."
        )}
      </p>
    </form>
  );
}
