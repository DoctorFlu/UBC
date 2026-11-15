"use client";

import { PenLine, RotateCcw } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";
import { Toggle } from "@/components/ui/Toggle";
import { type Mandate, type MarketCategory, categoryLabels } from "@/lib/domain";
import { formatUsdCents, parseUsdToCents } from "@/lib/format";

import styles from "./mandate.module.css";

type AmountKey = "totalBudgetCents" | "maxOrderCents" | "approvalThresholdCents" | "dailyLossLimitCents";

const amountFields: readonly { key: AmountKey; label: string; hint: string }[] = [
  { key: "totalBudgetCents", label: "Total budget", hint: "All the agent may spend under this mandate." },
  { key: "maxOrderCents", label: "Max order size", hint: "Larger intents are rejected with MAX_ORDER_SIZE." },
  {
    key: "approvalThresholdCents",
    label: "Approval threshold",
    hint: "Intents above this wait for your signature instead of executing.",
  },
  {
    key: "dailyLossLimitCents",
    label: "Daily loss limit",
    hint: "New intents stop once today's losses reach it.",
  },
];

const allCategories = Object.keys(categoryLabels) as MarketCategory[];

function plainDollars(cents: number) {
  return formatUsdCents(cents, { trimWholeCents: true }).replace("$", "");
}

/**
 * The policy editor's frame: edit a draft, see exactly what changes, then sign. Mock for now:
 * #15 encodes the draft into `setPolicy` and signs it with the owner's wallet.
 */
export function MandateEditor({ mandate }: { mandate: Mandate }) {
  const toast = useToast();
  const initialAmounts = Object.fromEntries(
    amountFields.map(({ key }) => [key, plainDollars(mandate[key])]),
  ) as Record<AmountKey, string>;
  const [amounts, setAmounts] = useState(initialAmounts);
  const [categories, setCategories] = useState<readonly MarketCategory[]>(mandate.allowedCategories);

  const parsed = Object.fromEntries(
    amountFields.map(({ key }) => [key, parseUsdToCents(amounts[key])]),
  ) as Record<AmountKey, number | null>;
  const errors: Partial<Record<AmountKey, string>> = {};
  for (const { key } of amountFields) {
    if (parsed[key] === null) errors[key] = "Enter a dollar amount, like 50 or 50.25.";
  }
  if (
    parsed.maxOrderCents !== null &&
    parsed.totalBudgetCents !== null &&
    parsed.maxOrderCents > parsed.totalBudgetCents
  ) {
    errors.maxOrderCents = "Max order size can't be more than the total budget.";
  }
  if (
    parsed.approvalThresholdCents !== null &&
    parsed.maxOrderCents !== null &&
    parsed.approvalThresholdCents > parsed.maxOrderCents
  ) {
    errors.approvalThresholdCents = "Set it at or below the max order size, or nothing will ever be held.";
  }

  const changes = [
    ...amountFields.flatMap(({ key, label }) => {
      const next = parsed[key];
      return next !== null && next !== mandate[key]
        ? [{ label, from: formatUsdCents(mandate[key]), to: formatUsdCents(next) }]
        : [];
    }),
    ...allCategories.flatMap((category) => {
      const was = mandate.allowedCategories.includes(category);
      const now = categories.includes(category);
      return was === now
        ? []
        : [
            {
              label: `${categoryLabels[category]} markets`,
              from: was ? "Allowed" : "Blocked",
              to: now ? "Allowed" : "Blocked",
            },
          ];
    }),
  ];
  const hasErrors = Object.values(errors).some(Boolean) || categories.length === 0;

  const reset = () => {
    setAmounts(initialAmounts);
    setCategories(mandate.allowedCategories);
  };

  return (
    <div className={styles.editor}>
      <Card
        title="Edit the rules"
        description={`Version ${mandate.version.toString()} is in force. Edit a draft here; nothing changes until you sign it.`}
      >
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            toast({
              title: "Draft ready to sign",
              description: `${changes.length.toString()} ${changes.length === 1 ? "change" : "changes"}. Signing arrives with the policy editor.`,
              tone: "info",
            });
          }}
        >
          <div className={styles.amounts}>
            {amountFields.map(({ key, label, hint }) => (
              <Field key={key} label={label} hint={hint} error={errors[key]}>
                {(control) => (
                  <Input
                    {...control}
                    prefix="$"
                    suffix="USDC"
                    inputMode="decimal"
                    autoComplete="off"
                    spellCheck={false}
                    value={amounts[key]}
                    onChange={(event) => setAmounts((current) => ({ ...current, [key]: event.target.value }))}
                  />
                )}
              </Field>
            ))}
          </div>

          <fieldset className={styles.categories}>
            <legend className={styles.legend}>Allowed markets</legend>
            <p className={styles.legendHint}>
              Intents on any other category are rejected with CATEGORY_NOT_ALLOWED.
            </p>
            <div className={styles.toggles}>
              {allCategories.map((category) => (
                <Toggle
                  key={category}
                  label={categoryLabels[category]}
                  checked={categories.includes(category)}
                  onChange={(checked) =>
                    setCategories((current) =>
                      checked ? [...current, category] : current.filter((value) => value !== category),
                    )
                  }
                />
              ))}
            </div>
            {categories.length === 0 ? (
              <p className={styles.fieldsetError} role="alert">
                Allow at least one category, or pause the agent instead.
              </p>
            ) : null}
          </fieldset>

          <div className={styles.formActions}>
            <Button
              type="submit"
              variant="primary"
              icon={<PenLine aria-hidden />}
              disabled={changes.length === 0 || hasErrors}
            >
              Review and sign
            </Button>
            <Button
              type="button"
              variant="ghost"
              icon={<RotateCcw aria-hidden />}
              onClick={reset}
              disabled={changes.length === 0}
            >
              Discard draft
            </Button>
          </div>
        </form>
      </Card>

      <Card
        className={styles.diff}
        tone="sunken"
        title="What changes"
        description="The draft against the version in force."
        headingLevel={2}
      >
        {changes.length === 0 ? (
          <p className={styles.noChanges}>No changes yet. Edit a rule to see it here before you sign.</p>
        ) : (
          <dl className={styles.changeList}>
            {changes.map((change) => (
              <div key={change.label} className={styles.change}>
                <dt>{change.label}</dt>
                <dd className="num">
                  <span className={styles.from}>{change.from}</span> to <strong>{change.to}</strong>
                </dd>
              </div>
            ))}
          </dl>
        )}
      </Card>
    </div>
  );
}
