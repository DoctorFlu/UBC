"use client";

import { useRouter } from "next/navigation";
import { type SyntheticEvent, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";
import { useMandateScope } from "@/lib/mandate/MandateContext";

import styles from "./setup.module.css";

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
 * The mandate's name (#95), which an admin can change on their session alone: it is a label for people and
 * the agent, and no contract, key or passkey prompt binds to it. The change is listed in Audit's owner
 * actions with the old and the new name.
 */
export function RenameCard() {
  const scope = useMandateScope();
  const router = useRouter();
  const toast = useToast();
  const current = scope?.mandate.name ?? "";
  const [name, setName] = useState(current);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  if (!scope) return null;
  const { mandate, canAct } = scope;
  const trimmed = name.trim();

  async function rename(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (trimmed === "") {
      setError("Name the mandate, like “Hedge my BTC”.");
      return;
    }
    if (trimmed === mandate.name) return;
    setError(undefined);
    setBusy(true);
    try {
      const response = await fetch(`/api/console/mandates/${encodeURIComponent(mandate.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!response.ok) {
        setError(await errorText(response));
        return;
      }
      setName(trimmed);
      toast({ title: "Mandate renamed", description: `It is now “${trimmed}”.`, tone: "success" });
      // The switcher, Home and the page titles read the name from the server.
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Mandate name"
      description="Shown in the switcher, on Home and to the agent. Renaming changes no rule and no contract."
      headingLevel={2}
    >
      {canAct ? (
        <form onSubmit={(event) => void rename(event)} noValidate>
          <Field label="Name" error={error}>
            <div className={styles.tokenForm}>
              <Input
                name="mandate-name"
                autoComplete="off"
                value={name}
                onValueChange={(value) => {
                  setName(value);
                  setError(undefined);
                }}
                maxLength={60}
              />
              <Button type="submit" variant="secondary" loading={busy} disabled={trimmed === mandate.name}>
                Rename
              </Button>
            </div>
          </Field>
        </form>
      ) : (
        <div className={styles.rename}>
          <p data-testid="mandate-name">{mandate.name}</p>
          <p className={styles.muted}>Only a workspace admin can rename it.</p>
        </div>
      )}
    </Card>
  );
}
