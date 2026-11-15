"use client";

import { type ConsoleHolding, holdingQuantitySchema, holdingSchema } from "@mandate/shared";
import { Plus, Save, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";
import { formatDateUtc, formatTimeUtc } from "@/lib/format";
import { ownerBlockedReason } from "@/lib/owner/access";
import { useOwnerRequest } from "@/lib/owner/useOwnerRequest";

import styles from "./hedge.module.css";

interface Row {
  key: number;
  asset: string;
  quantity: string;
  note?: string;
}

let nextKey = 0;
const toRows = (holdings: readonly ConsoleHolding[]): Row[] =>
  holdings.map((holding) => ({ key: (nextKey += 1), ...holding }));
const signature = (rows: readonly Pick<Row, "asset" | "quantity">[]) =>
  JSON.stringify(rows.map((row) => [row.asset.trim().toUpperCase(), row.quantity.trim()]));

interface RowErrors {
  asset?: string;
  quantity?: string;
}

function validate(rows: readonly Row[]): RowErrors[] {
  const seen = new Set<string>();
  return rows.map((row) => {
    const errors: RowErrors = {};
    const asset = row.asset.trim().toUpperCase();
    if (!holdingSchema.shape.asset.safeParse(asset).success) errors.asset = "Use the ticker, like BTC.";
    else if (seen.has(asset)) errors.asset = "Already listed.";
    seen.add(asset);
    if (!holdingQuantitySchema.safeParse(row.quantity.trim()).success) {
      errors.quantity = "A number like 0.05, up to 8 decimals.";
    }
    return errors;
  });
}

/**
 * What the owner holds, which the agent reads (GET holdings) to size a hedge. Saving is an offchain
 * change signed by the owner's wallet, so nobody else can tell the agent what you own.
 */
export function HoldingsEditor({
  holdings,
  updatedAt,
}: {
  holdings: readonly ConsoleHolding[];
  updatedAt: string | null;
}) {
  const toast = useToast();
  const { request, pending, access } = useOwnerRequest();
  const blocked = ownerBlockedReason(access);
  const [rows, setRows] = useState(() => toRows(holdings));
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

  const update = (key: number, patch: Partial<Row>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const save = async () => {
    const payload = {
      holdings: rows.map((row) => ({
        asset: row.asset.trim().toUpperCase(),
        quantity: row.quantity.trim(),
        ...(row.note ? { note: row.note } : {}),
      })),
    };
    const result = await request("/api/console/holdings", "PUT", "holdings.save", payload);
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
        if (valid && dirty) void save();
      }}
    >
      {rows.length === 0 ? (
        <p className={styles.muted}>
          Nothing listed. Add the BTC you want protected and the agent sizes a ladder to it.
        </p>
      ) : (
        <ul className={styles.holdingRows}>
          {rows.map((row, index) => (
            <li key={row.key} className={styles.holdingRow} data-testid="holding-row">
              <Field label="Asset" error={errors[index]?.asset}>
                {(control) => (
                  <Input
                    {...control}
                    value={row.asset}
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={10}
                    onChange={(event) => update(row.key, { asset: event.target.value.toUpperCase() })}
                  />
                )}
              </Field>
              <Field label="Quantity" error={errors[index]?.quantity}>
                {(control) => (
                  <Input
                    {...control}
                    value={row.quantity}
                    inputMode="decimal"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => update(row.key, { quantity: event.target.value })}
                  />
                )}
              </Field>
              <Button
                variant="ghost"
                iconOnly
                className={styles.removeHolding}
                aria-label={`Remove ${row.asset || "this row"}`}
                icon={<Trash2 aria-hidden />}
                onClick={() => setRows((current) => current.filter((other) => other.key !== row.key))}
              />
            </li>
          ))}
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
              { key: (nextKey += 1), asset: current.length === 0 ? "BTC" : "", quantity: "" },
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
          disabled={!valid || !dirty || blocked !== null}
        >
          Sign and save
        </Button>
      </div>
      <p className={styles.muted}>
        {blocked && access.kind !== "loading" && dirty
          ? blocked
          : updatedAt
            ? `Saved ${formatDateUtc(updatedAt)} at ${formatTimeUtc(updatedAt)}.`
            : "Never saved."}
      </p>
    </form>
  );
}
