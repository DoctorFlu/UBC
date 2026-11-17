"use client";

import { CopyButton } from "@/components/ui/CopyButton";

import styles from "./setup.module.css";

/** A new agent token, shown this once, with the steps to connect Grok Bot with it. */
export function TokenReveal({ token, mcpUrl }: { token: string; mcpUrl: string | null }) {
  return (
    <div className={styles.tokenReveal}>
      <div className={styles.copyRow}>
        <code className={styles.endpoint} translate="no" data-testid="new-token">
          {token}
        </code>
        <CopyButton value={token} what="token" />
      </div>
      <ConnectSteps mcpUrl={mcpUrl} />
    </div>
  );
}

export function ConnectSteps({ mcpUrl }: { mcpUrl: string | null }) {
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
