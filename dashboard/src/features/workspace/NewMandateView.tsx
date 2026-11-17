"use client";

import { CATEGORY_IDS, CATEGORY_LABELS } from "@mandate/shared";
import { ArrowRight, KeyRound } from "lucide-react";
import { type SyntheticEvent, useState } from "react";

import { Button, ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { Field, Input } from "@/components/ui/Field";
import { PageHeader } from "@/components/ui/PageHeader";
import { useToast } from "@/components/ui/Toast";
import { Toggle } from "@/components/ui/Toggle";
import { TokenReveal } from "@/features/setup/TokenReveal";
import { AMOUNT_LABELS, type AmountKey } from "@/features/rules/rules-diff";
import { FIRST_MANDATE, amountHints, checkDraft, draftFrom } from "@/features/rules/rules-draft";
import type { CreatedMandateResponse } from "@/lib/accounts/types";
import { mandatePath } from "@/lib/mandate-path";
import { PasskeyFailure, confirmWithPasskey } from "@/lib/owner/passkey";

import styles from "./workspace.module.css";

const MAIN_AMOUNTS: readonly AmountKey[] = ["budgetCents", "maxTradeCents", "approvalAboveCents"];

export interface NewMandateProps {
  /** Who deploys the contract: the console (demo chain, with the first rules), or the owner's wallet (Arc). */
  deployer: "server" | "wallet";
  /** Set when no new mandate can be made here, with the sentence to show instead of the form. */
  blocked: string | null;
}

async function errorText(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    if (body.error?.message) return body.error.message;
  } catch {
    // Not JSON.
  }
  return `The console answered ${response.status.toString()}.`;
}

/**
 * A new mandate (#95): its name, its first rules, its own Policy contract and its own agent, whose first
 * token is shown once at the end with the steps to connect Grok Bot. One passkey prompt confirms the name
 * and the rules together; the button says so.
 */
export function NewMandateView({ deployer, blocked }: NewMandateProps) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState(() => draftFrom(FIRST_MANDATE));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedMandateResponse | null>(null);
  const { errors, next } = checkDraft(draft, false);
  const withRules = deployer === "server";

  async function create(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "") {
      setNameError("Name the mandate, like “Hedge my BTC”.");
      return;
    }
    if (withRules && next === null) return;
    setNameError(undefined);
    setProblem(null);
    setBusy(true);
    const rules = withRules ? next : null;
    try {
      const stepUp = await confirmWithPasskey({ kind: "create-mandate", name: trimmed, rules });
      const response = await fetch("/api/console/mandates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed, rules, stepUp }),
      });
      if (!response.ok) {
        setProblem(await errorText(response));
        return;
      }
      setCreated((await response.json()) as CreatedMandateResponse);
    } catch (failure) {
      if (failure instanceof PasskeyFailure && failure.cancelled) {
        toast({ title: "No mandate created", description: failure.message });
      } else {
        setProblem(failure instanceof Error ? failure.message : String(failure));
      }
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    const { mandate } = created;
    const deployed = mandate.contract !== null;
    return (
      <div className={styles.view}>
        <PageHeader
          title={`${mandate.name} is ready`}
          description={
            deployed
              ? "Its Policy contract is deployed with the rules you confirmed, and its agent has a token."
              : withRules
                ? "The mandate and its agent exist; its contract did not deploy yet."
                : "The mandate and its agent exist. Next, deploy its Policy contract with your wallet."
          }
        />
        {created.deployProblem ? (
          <p className={styles.problem} role="alert">
            {created.deployProblem} Open the mandate&apos;s Setup page to try again.
          </p>
        ) : null}
        <Card
          title="Copy the agent's token now"
          description="It is shown this once. The console keeps only a fingerprint of it, so it can't show it again."
        >
          <TokenReveal token={created.token.token} mcpUrl={created.mcpUrl} />
        </Card>
        <div className={styles.actions}>
          <ButtonLink
            href={mandatePath(mandate.id, deployed ? "" : "/setup")}
            variant="primary"
            icon={<ArrowRight aria-hidden />}
          >
            {deployed ? `Open ${mandate.name}` : "Go to Setup"}
          </ButtonLink>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.view}>
      <PageHeader
        title="New mandate"
        description="A mandate is one agent under one set of rules, with its own Policy contract. Mandates never share budgets, approvals or tokens."
      />
      {blocked ? (
        <p className={styles.note} role="status">
          {blocked}
        </p>
      ) : (
        <form className={styles.form} onSubmit={(event) => void create(event)} noValidate>
          <section className={styles.step} aria-labelledby="new-name">
            <h2 id="new-name" className={styles.stepTitle}>
              Name
            </h2>
            <Field label="Mandate name" hint="Shown in the switcher and on Home." error={nameError}>
              <Input
                name="mandate-name"
                autoComplete="off"
                value={name}
                onValueChange={setName}
                maxLength={60}
              />
            </Field>
          </section>

          {withRules ? (
            <section className={styles.step} aria-labelledby="new-rules">
              <h2 id="new-rules" className={styles.stepTitle}>
                First rules
              </h2>
              <p className={styles.stepText}>
                The contract enforces these from its first block. Change them later on the Rules page.
              </p>
              <div className={styles.ruleGrid}>
                {MAIN_AMOUNTS.map((key) => (
                  <Field key={key} label={AMOUNT_LABELS[key]} hint={amountHints[key]} error={errors[key]}>
                    <Input
                      prefix="$"
                      suffix="USDC"
                      inputMode="decimal"
                      autoComplete="off"
                      spellCheck={false}
                      value={draft.amounts[key]}
                      onValueChange={(value) =>
                        setDraft((current) => ({ ...current, amounts: { ...current.amounts, [key]: value } }))
                      }
                    />
                  </Field>
                ))}
              </div>
              <fieldset className={styles.step}>
                <legend className={styles.stepTitle}>Allowed markets</legend>
                <div className={styles.categories}>
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
                  <p className={styles.problem} role="alert">
                    Allow at least one category.
                  </p>
                ) : null}
              </fieldset>
              <Disclosure title="More rules" summary="Daily loss limit" headingLevel={3}>
                <Field
                  label={AMOUNT_LABELS.dailyLossCents}
                  hint={amountHints.dailyLossCents}
                  error={errors.dailyLossCents}
                >
                  <Input
                    prefix="$"
                    suffix="USDC"
                    inputMode="decimal"
                    autoComplete="off"
                    spellCheck={false}
                    value={draft.amounts.dailyLossCents}
                    onValueChange={(value) =>
                      setDraft((current) => ({
                        ...current,
                        amounts: { ...current.amounts, dailyLossCents: value },
                      }))
                    }
                  />
                </Field>
              </Disclosure>
            </section>
          ) : (
            <p className={styles.stepText}>
              On this network your wallet deploys the mandate&apos;s Policy contract and signs its first
              rules, from the new mandate&apos;s Setup page.
            </p>
          )}

          <section className={styles.step} aria-labelledby="new-agent">
            <h2 id="new-agent" className={styles.stepTitle}>
              Agent
            </h2>
            <p className={styles.stepText}>
              The mandate gets its own agent key and a first token for Grok Bot, shown once when it is ready.
            </p>
          </section>

          {problem ? (
            <p className={styles.problem} role="alert">
              {problem}
            </p>
          ) : null}
          <div className={styles.actions}>
            <Button
              type="submit"
              variant="primary"
              icon={<KeyRound aria-hidden />}
              loading={busy}
              disabled={withRules && next === null}
            >
              {withRules ? "Create and deploy with passkey" : "Create with passkey"}
            </Button>
            <p className={styles.note}>
              Your passkey confirms the name{withRules ? " and these rules" : ""}, once.
            </p>
          </div>
        </form>
      )}
    </div>
  );
}
