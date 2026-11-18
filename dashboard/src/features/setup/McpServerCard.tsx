"use client";

import { useEffect, useState } from "react";

import { Card } from "@/components/ui/Card";
import { CopyButton } from "@/components/ui/CopyButton";
import { MCP_SERVER_PATH, type McpServerStatus } from "@/lib/setup-mcp";

import styles from "./setup.module.css";

/** How often Setup asks again, so a tunnel started after the page opened shows up on its own. */
const REFRESH_MS = 10_000;

function Address({ url, what }: { url: string; what: string }) {
  return (
    <div className={styles.copyRow}>
      <code className={styles.endpoint} translate="no">
        {url}
      </code>
      <CopyButton value={url} what={what} />
    </div>
  );
}

/**
 * The address to add to Grok Bot. `configured` is the console's `MCP_PUBLIC_URL`, known without asking
 * (and all a preview, which never asks, has). Without it, the console asks the MCP server on this machine: its local address,
 * whether it runs, and the public address a tunnel last reached it at.
 */
export function McpServerCard({ configured, ask = true }: { configured: string | null; ask?: boolean }) {
  const [status, setStatus] = useState<McpServerStatus | null>(
    configured !== null ? { kind: "configured", url: configured } : ask ? null : { kind: "unknown" },
  );

  useEffect(() => {
    if (configured !== null || !ask) return;
    let stopped = false;
    const poll = async () => {
      try {
        const response = await fetch(MCP_SERVER_PATH, { cache: "no-store" });
        if (!response.ok || stopped) return;
        setStatus((await response.json()) as McpServerStatus);
      } catch {
        // The console is unreachable: the page says so elsewhere. Keep what was shown.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [configured, ask]);

  return (
    <Card
      title="MCP server"
      description="Add this address to Grok Bot as a connector. It only proposes intents; it cannot move funds."
      headingLevel={2}
    >
      <div className={styles.mcpServer} data-testid="mcp-server" data-kind={status?.kind ?? "loading"}>
        <McpServerBody status={status} />
      </div>
    </Card>
  );
}

function McpServerBody({ status }: { status: McpServerStatus | null }) {
  if (status === null) return <p className={styles.muted}>Looking for the MCP server…</p>;
  switch (status.kind) {
    case "configured":
      return <Address url={status.url} what="MCP server address" />;
    case "unknown":
      return (
        <p className={styles.muted}>
          Not configured. Set <code>MCP_PUBLIC_URL</code> on the console to the public address of the MCP
          server.
        </p>
      );
    case "local":
      if (!status.running) {
        return (
          <p className={styles.muted}>
            No MCP server answers on this machine at <code translate="no">{status.localUrl}</code>. Start it
            with <code>npm run dev:mcp</code>, then run <code>npm run dev:tunnel</code> for the public address
            Grok Bot needs.
          </p>
        );
      }
      if (status.publicUrl !== null) {
        return (
          <>
            <Address url={status.publicUrl} what="MCP server address" />
            <p className={styles.muted}>
              The public address Grok Bot last reached the MCP server on this machine at, through a tunnel. A
              quick tunnel gets a new address each time it restarts; update the connector when it does.
            </p>
          </>
        );
      }
      return (
        <>
          <Address url={status.localUrl} what="local MCP server address" />
          <p className={styles.muted}>
            Running on this machine. Grok Bot can&apos;t reach a local address: run{" "}
            <code>npm run dev:tunnel</code>, and the public address it prints shows here once it is reached.
          </p>
        </>
      );
  }
}
