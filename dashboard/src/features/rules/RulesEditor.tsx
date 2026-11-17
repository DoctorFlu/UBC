"use client";

import {
  CATEGORY_IDS,
  CATEGORY_LABELS,
  Category,
  type CategoryId,
  type PolicyRules,
  categoriesFromMask,
  categoryMask,
} from "@mandate/shared";
import { PenLine, RotateCcw } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Field";
import { Toggle } from "@/components/ui/Toggle";
import { formatUsdCents, parseUsdToCents } from "@/lib/format";
import type { ChainView } from "@/lib/live/types";
import { ownerBlockedReason, useOwnerAccess } from "@/lib/owner/access";
import { useHydrated } from "@/lib/useHydrated";

import styles from "./rules.module.css";
import { BacktestPanel } from "./BacktestPanel";
import { PolicyReview } from "./PolicyReview";
import { AMOUNT_LABELS, type AmountKey, rulesDiff } from "./rules-diff";

const amountHints: Record<AmountKey, string> = {
  budgetCents: "All the agent may ever commit to buys. It is a lifetime cap and does not reset.",
  maxTradeCents: "Larger intents are rejected as “over max trade size”.",
  approvalAboveCents: "Intents above this wait for your signature. 0 means never ask.",
  dailyLossCents: "New intents stop once today’s realized losses reach it. 0 turns it off.",
};

const AMOUNT_KEYS = Object.keys(AMOUNT_LABELS) as AmountKey[];

/** A starting point for the first rules: small, crypto only, and every rule on. */
const FIRST_MANDATE: PolicyRules = {
  budgetCents: 20_000,
  maxTradeCents: 2_500,
  allowedCategories: categoryMask([Category.Crypto]),
  approvalAboveCents: 2_000,
  dailyLossCents: 4_000,
  paused: false,
};

function plainDollars(cents: number) {
  return formatUsdCents(cents, { trimWholeCents: true }).replace("$", "");
}

interface Draft {
  amounts: Record<AmountKey, string>;
  categories: readonly CategoryId[];
}

function draftFrom(rules: PolicyRules): Draft {
  return {
    amounts: Object.fromEntries(AMOUNT_KEYS.map((key) => [key, plainDollars(rules[key])])) as Record<
      AmountKey,
      string
    >,
    categories: categoriesFromMask(rules.allowedCategories),
  };
}

export interface RulesEditorProps {
  /** Rules in force, or null before the first `setPolicy`. */
  rules: PolicyRules | null;
  version: number;
  /** The history the draft is replayed against. */
  chain: Pick<ChainView, "events" | "intents">;
}

/**
 * The policy editor: edit a draft, see exactly what changes and how past intents would have fared
 * under it, review it, then sign `setPolicy` with the owner's wallet. The rules shown in force always come from the contract's events, never from the draft.
 */
export function RulesEditor({ rules, version, chain }: RulesEditorProps) {
  const access = useOwnerAccess();
  const blocked = ownerBlockedReason(access);
  const hydrated = useHydrated();
  const base = rules ?? FIRST_MANDATE;
  const [draft, setDraft] = useState(() => draftFrom(base));
  // The review dialog's title, fixed when it opens: signing a first mandate must not retitle the
  // dialog to "new rules" the moment the contract's event lands.
  const [reviewing, setReviewing] = useState<string | null>(null);
  // When new rules land (signed here or elsewhere), an untouched draft follows them.
  const [baseline, setBaseline] = useState(base);
  if (baseline !== base && JSON.stringify(baseline) !== JSON.stringify(base)) {
    const untouched = JSON.stringify(draft) === JSON.stringify(draftFrom(baseline));
    setBaseline(base);
    if (untouched) setDraft(draftFrom(base));
  }

  const parsed = Object.fromEntries(
    AMOUNT_KEYS.map((key) => [key, parseUsdToCents(draft.amounts[key])]),
  ) as Record<AmountKey, number | null>;
  const errors: Partial<Record<AmountKey, string>> = {};
  for (const key of AMOUNT_KEYS) {
    if (parsed[key] === null) errors[key] = "Enter a dollar amount, like 50 or 50.25.";
  }
  if (
    parsed.maxTradeCents !== null &&
    parsed.budgetCents !== null &&
    parsed.maxTradeCents > parsed.budgetCents
  ) {
    errors.maxTradeCents = "The max trade size can't be more than the budget.";
  }
  if (
    parsed.approvalAboveCents !== null &&
    parsed.maxTradeCents !== null &&
    parsed.approvalAboveCents > parsed.maxTradeCents
  ) {
    errors.approvalAboveCents = "Set it at or below the max trade size, or 0 to never ask.";
  }
  const hasErrors = Object.values(errors).some(Boolean) || draft.categories.length === 0;

  const next: PolicyRules | null = hasErrors
    ? null
    : {
        budgetCents: parsed.budgetCents ?? 0,
        maxTradeCents: parsed.maxTradeCents ?? 0,
        approvalAboveCents: parsed.approvalAboveCents ?? 0,
        dailyLossCents: parsed.dailyLossCents ?? 0,
        allowedCategories: categoryMask(draft.categories),
        // setPolicy writes the pause flag too: keep it as it is; only the kill switch changes it.
        paused: rules?.paused ?? false,
      };
  const changes = next ? rulesDiff(rules, next) : [];

  return (
    <div className={styles.editor}>
      <Card
        title={rules ? "Edit the rules" : "Set the first rules"}
        description={
          rules
            ? `Version ${version.toString()} is in force. Edit a draft here; nothing changes until you sign it.`
            : "Until you sign the first rules, the Policy contract rejects every intent. These values are a starting point."
        }
      >
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            if (next && changes.length > 0) {
              setReviewing(rules ? "Review the new rules" : "Review the first rules");
            }
          }}
        >
          <div className={styles.amounts}>
            {AMOUNT_KEYS.map((key) => (
              <Field key={key} label={AMOUNT_LABELS[key]} hint={amountHints[key]} error={errors[key]}>
                <Input
                  prefix="$"
                  suffix="USDC"
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  value={draft.amounts[key]}
                  onValueChange={(value) =>
                    setDraft((current) => ({
                      ...current,
                      amounts: { ...current.amounts, [key]: value },
                    }))
                  }
                />
              </Field>
            ))}
          </div>

          <fieldset className={styles.categories}>
            <legend className={styles.legend}>Allowed markets</legend>
            <p className={styles.legendHint}>
              Intents in any other category are rejected as &ldquo;category not allowed&rdquo;.
            </p>
            <div className={styles.toggles}>
              {CATEGORY_IDS.map((category) => (
                <Toggle
                  key={category}
                  label={CATEGORY_LABELS[category]}
                  checked={draft.categories.includes(category)}
                  onChange={(checked) =>
                    setDraft((current) => ({
                      ...current,
                      categories: checked
                        ? [...current.categories, category]
                        : current.categories.filter((value) => value !== category),
                    }))
                  }
                />
              ))}
            </div>
            {draft.categories.length === 0 ? (
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
              disabled={!hydrated || changes.length === 0 || hasErrors}
            >
              Review and sign
            </Button>
            <Button
              type="button"
              variant="ghost"
              icon={<RotateCcw aria-hidden />}
              onClick={() => setDraft(draftFrom(base))}
              disabled={JSON.stringify(draft) === JSON.stringify(draftFrom(base))}
            >
              Discard draft
            </Button>
            {blocked && access.kind !== "loading" ? <p className={styles.blockedNote}>{blocked}</p> : null}
          </div>
        </form>
      </Card>

      <Card
        className={styles.diff}
        tone="sunken"
        title="What changes"
        description={
          rules ? "The draft against the version in force." : "The first rules the contract will enforce."
        }
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

      <Card
        className={styles.backtestCard}
        title="Backtest"
        description="Every intent the agent has proposed, replayed through the draft with the contract's own rules. It updates as you type; nothing is signed."
        headingLevel={2}
      >
        <BacktestPanel chain={chain} draft={next} />
      </Card>

      {next ? (
        <PolicyReview
          open={reviewing !== null}
          onClose={() => setReviewing(null)}
          next={next}
          title={reviewing ?? "Review the new rules"}
        />
      ) : null}
    </div>
  );
}
