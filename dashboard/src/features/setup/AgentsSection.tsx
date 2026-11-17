"use client";

import { KeyRound, Plus } from "lucide-react";
import { type SyntheticEvent, useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { CopyButton } from "@/components/ui/CopyButton";
import { Dialog } from "@/components/ui/Dialog";
import { Field, Input } from "@/components/ui/Field";
import { HexValue } from "@/components/ui/HexValue";
import { ErrorState, SkeletonText } from "@/components/ui/States";
import { type Column, Table } from "@/components/ui/Table";
import { useToast } from "@/components/ui/Toast";
import { When } from "@/components/ui/When";
import { AuthFailure, registerPasskey } from "@/features/auth/passkey";
import type { AgentTokenView, AgentView, AgentsResponse, CreatedToken } from "@/lib/accounts/types";

import styles from "./setup.module.css";

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  const response = await fetch(url, { ...init, headers });
  const body = (await response.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? "The console could not do that. Try again.");
  return body;
}

/** The workspace's agents, their tokens, and how to connect Grok Bot with one. */
export function AgentsSection() {
  const [data, setData] = useState<AgentsResponse | null>(null);
  const [failed, setFailed] = useState(false);
  // Bumped to load the list again after a change or a failed load.
  const [version, setVersion] = useState(0);
  const load = useCallback(() => {
    setVersion((current) => current + 1);
  }, []);
  useEffect(() => {
    let current = true;
    request<AgentsResponse>("/api/console/agents").then(
      (loaded) => {
        if (!current) return;
        setData(loaded);
        setFailed(false);
      },
      () => {
        if (current) setFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [version]);

  return (
    <section className={styles.agents} aria-labelledby="agents-heading">
      <div className={styles.sectionHead}>
        <h2 id="agents-heading" className={styles.sectionTitle}>
          Agents
        </h2>
        <p className={styles.muted}>
          A token lets one app, such as Grok Bot, act as your agent through the MCP server. Each token is
          shown once. Revoke it here when an app should stop.
        </p>
      </div>
      {failed ? (
        <ErrorState
          title="Agents did not load"
          action={
            <Button variant="secondary" size="sm" onClick={load}>
              Try again
            </Button>
          }
        >
          The console could not list this workspace&apos;s agents.
        </ErrorState>
      ) : data === null ? (
        <Card>
          <SkeletonText lines={3} />
        </Card>
      ) : (
        data.agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} mcpUrl={data.mcpUrl} onChange={load} />
        ))
      )}
      <PasskeyCard />
    </section>
  );
}

function AgentCard({
  agent,
  mcpUrl,
  onChange,
}: {
  agent: AgentView;
  mcpUrl: string | null;
  onChange: () => void;
}) {
  const toast = useToast();
  // Named for the usual first app, until the agent has a live token.
  const [name, setName] = useState(agent.tokens.some((token) => !token.revokedAt) ? "" : "Grok Bot");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [revoking, setRevoking] = useState<AgentTokenView | null>(null);
  const [busyRevoke, setBusyRevoke] = useState(false);

  async function create(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreating(true);
    setError(undefined);
    try {
      setCreated(
        await request<CreatedToken>(`/api/console/agents/${agent.id}/tokens`, {
          method: "POST",
          body: JSON.stringify({ name }),
        }),
      );
      // The next token is for another app: start it with an empty name.
      setName("");
      onChange();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setCreating(false);
    }
  }

  async function revoke(token: AgentTokenView) {
    setBusyRevoke(true);
    try {
      await request(`/api/console/agents/${agent.id}/tokens/${token.id}`, { method: "DELETE" });
      toast({ title: `Revoked "${token.name}"`, description: "Apps using it stop working at once." });
      setRevoking(null);
      onChange();
    } catch (failure) {
      toast({
        title: "Not revoked",
        description: failure instanceof Error ? failure.message : String(failure),
        tone: "danger",
      });
    } finally {
      setBusyRevoke(false);
    }
  }

  const columns: Column<AgentTokenView>[] = [
    { key: "name", header: "Token", role: "primary", cell: (token) => token.name },
    { key: "created", header: "Created", nowrap: true, cell: (token) => <When at={token.createdAt} /> },
    {
      key: "used",
      header: "Last used",
      nowrap: true,
      cell: (token) => (token.lastUsedAt ? <When at={token.lastUsedAt} /> : "Never"),
    },
    {
      key: "actions",
      header: "Status",
      role: "actions",
      align: "end",
      cell: (token) =>
        token.revokedAt ? (
          <span className={styles.muted}>
            Revoked <When inSentence at={token.revokedAt} />
          </span>
        ) : (
          <Button size="sm" variant="dangerOutline" onClick={() => setRevoking(token)}>
            Revoke
          </Button>
        ),
    },
  ];

  return (
    <Card
      title={agent.name}
      description={`Acts for the mandate "${agent.mandate.name}".`}
      headingLevel={3}
      actions={
        agent.address ? (
          <HexValue value={agent.address} kind="address" />
        ) : (
          <span className={styles.muted}>Signs with the server&apos;s own key</span>
        )
      }
    >
      <div className={styles.agentBody}>
        {agent.mandate.hasContract ? null : (
          <p className={styles.muted}>
            This mandate has no Policy contract yet. The agent can plan, store its reasons and ask for rule
            changes; it cannot propose trades until a contract names it.
          </p>
        )}
        <Table
          caption={`Tokens of ${agent.name}`}
          captionHidden
          columns={columns}
          rows={agent.tokens}
          rowKey={(token) => token.id}
          rowTone={(token) => (token.revokedAt ? "muted" : undefined)}
          empty={<p className={styles.muted}>No tokens yet. Create one to connect Grok Bot.</p>}
        />
        <form onSubmit={(event) => void create(event)} noValidate>
          <Field label="New token" hint="Name it after the app that will use it." error={error}>
            {/* The button sits on the input's row, so the hint reads under both. */}
            <div className={styles.tokenForm}>
              <Input
                name="token-name"
                autoComplete="off"
                value={name}
                onValueChange={setName}
                maxLength={60}
              />
              <Button type="submit" variant="secondary" icon={<Plus aria-hidden />} loading={creating}>
                Create token
              </Button>
            </div>
          </Field>
        </form>
      </div>

      <Dialog
        open={created !== null}
        onClose={() => setCreated(null)}
        title="Copy your token now"
        description="It is shown this once. The console keeps only a fingerprint of it, so it can't show it again."
        footer={
          <Button variant="primary" onClick={() => setCreated(null)}>
            Done
          </Button>
        }
      >
        {created ? (
          <div className={styles.tokenReveal}>
            <div className={styles.copyRow}>
              <code className={styles.endpoint} translate="no" data-testid="new-token">
                {created.token}
              </code>
              <CopyButton value={created.token} what="token" />
            </div>
            <ConnectSteps mcpUrl={mcpUrl} />
          </div>
        ) : null}
      </Dialog>

      <Dialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={`Revoke "${revoking?.name ?? ""}"?`}
        description="Every app using this token stops working at once. This can't be undone."
        footer={
          <>
            <Button variant="ghost" onClick={() => setRevoking(null)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              loading={busyRevoke}
              onClick={() => {
                if (revoking) void revoke(revoking);
              }}
            >
              Revoke token
            </Button>
          </>
        }
      />
    </Card>
  );
}

function ConnectSteps({ mcpUrl }: { mcpUrl: string | null }) {
  return (
    <div className={styles.connect}>
      <h3 className={styles.connectTitle}>Connect Grok Bot</h3>
      <ol className={styles.connectSteps}>
        <li>In Grok, open Settings, then Connectors, and add a custom MCP connector.</li>
        <li>
          Server URL:{" "}
          {mcpUrl ? (
            <code translate="no">{mcpUrl}</code>
          ) : (
            <>
              the MCP server&apos;s public address (set <code>MCP_PUBLIC_URL</code> to show it here)
            </>
          )}
        </li>
        <li>Authentication: bearer token. Paste the token above.</li>
        <li>Ask Grok to run whoami: it answers with this agent and its mandate.</li>
      </ol>
    </div>
  );
}

function PasskeyCard() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function add() {
    setBusy(true);
    try {
      await registerPasskey("/api/console/passkeys", {});
      toast({ title: "Passkey added", description: "You can now sign in with it too." });
    } catch (failure) {
      toast({
        title: "No passkey added",
        description: failure instanceof AuthFailure ? failure.message : "Something went wrong. Try again.",
        tone: "danger",
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card
      title="Your passkeys"
      description="Add a passkey on a second device, so losing one device never locks you out."
      headingLevel={3}
    >
      <Button variant="secondary" icon={<KeyRound aria-hidden />} loading={busy} onClick={() => void add()}>
        Add a passkey
      </Button>
    </Card>
  );
}
