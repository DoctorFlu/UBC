"use client";

import { type ReactNode, createContext, use, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ConsoleNetwork, ConsoleSnapshot } from "./types";

/** Whether the browser is receiving the console's server-sent events. */
export type StreamConnection = "connecting" | "open" | "reconnecting";

interface LiveConsoleValue {
  snapshot: ConsoleSnapshot;
  connection: StreamConnection;
  /** Resolves with the first snapshot (current or later) that satisfies `test`, or null after `timeoutMs`. */
  waitFor: (
    test: (snapshot: ConsoleSnapshot) => boolean,
    timeoutMs: number,
  ) => Promise<ConsoleSnapshot | null>;
  /**
   * Reads the snapshot once over plain HTTP. An owner's write calls it after it succeeds, so the page shows
   * the change even when the event stream is stalled or reconnecting, as it can be behind a proxy.
   */
  refresh: () => Promise<void>;
}

const LiveConsoleContext = createContext<LiveConsoleValue | null>(null);
const NetworkContext = createContext<ConsoleNetwork | null>(null);

export const EVENTS_PATH = "/api/console/events";
export const SNAPSHOT_PATH = "/api/console/snapshot";
const RETRY_FIRST_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/**
 * Keeps the console's snapshot current: the server renders with `initial`, then the browser follows
 * /api/console/events, opening a new stream when the browser gives up on one; the first message after any (re)connect is a
 * full snapshot, accepted even when its `seq` is lower, which happens after the server restarts.
 */
export function LiveConsoleProvider({
  initial,
  follow = true,
  children,
}: {
  initial: ConsoleSnapshot;
  /** False for fixtures (the component gallery): keep `initial` and open no event stream. */
  follow?: boolean;
  children: ReactNode;
}) {
  const [snapshot, setSnapshot] = useState(initial);
  const [connection, setConnection] = useState<StreamConnection>("connecting");
  const latest = useRef(initial);
  const waiters = useRef(new Set<(snapshot: ConsoleSnapshot) => void>());
  const accept = useCallback((next: ConsoleSnapshot) => {
    latest.current = next;
    setSnapshot(next);
    for (const waiter of [...waiters.current]) waiter(next);
  }, []);

  useEffect(() => {
    if (!follow) return undefined;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let fresh = true;
    const connect = () => {
      const current = new EventSource(EVENTS_PATH);
      source = current;
      current.addEventListener("open", () => {
        fresh = true;
        attempt = 0;
        setConnection("open");
      });
      current.addEventListener("error", () => {
        setConnection("reconnecting");
        // EventSource retries a dropped connection by itself, but gives up for good on an HTTP error, such
        // as a proxy's 502 while the console wakes up: open a new stream after a growing pause.
        if (current.readyState === EventSource.CLOSED) {
          retry = setTimeout(connect, Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** attempt));
          attempt += 1;
        }
      });
      current.addEventListener("snapshot", (event) => {
        let next: ConsoleSnapshot;
        try {
          next = JSON.parse((event as MessageEvent<string>).data) as ConsoleSnapshot;
        } catch {
          return;
        }
        if (!fresh && next.seq <= latest.current.seq) return;
        fresh = false;
        setConnection("open");
        accept(next);
      });
    };
    connect();
    return () => {
      clearTimeout(retry);
      source?.close();
    };
  }, [follow, accept]);

  const refresh = useCallback(async () => {
    if (!follow) return;
    try {
      const response = await fetch(SNAPSHOT_PATH, { cache: "no-store" });
      if (!response.ok) return;
      const next = (await response.json()) as ConsoleSnapshot;
      // Newer only: the stream may already have delivered this change, or a later one.
      if (next.seq > latest.current.seq) accept(next);
    } catch {
      // The stream still brings the change once it is back.
    }
  }, [follow, accept]);

  const waitFor = useCallback(
    (test: (snapshot: ConsoleSnapshot) => boolean, timeoutMs: number) =>
      new Promise<ConsoleSnapshot | null>((resolve) => {
        if (test(latest.current)) {
          resolve(latest.current);
          return;
        }
        const done = (result: ConsoleSnapshot | null) => {
          clearTimeout(timer);
          waiters.current.delete(waiter);
          resolve(result);
        };
        const waiter = (next: ConsoleSnapshot) => {
          if (test(next)) done(next);
        };
        const timer = setTimeout(() => done(null), timeoutMs);
        waiters.current.add(waiter);
      }),
    [],
  );

  const value = useMemo(
    () => ({ snapshot, connection, waitFor, refresh }),
    [snapshot, connection, waitFor, refresh],
  );
  return (
    <LiveConsoleContext value={value}>
      <NetworkContext value={snapshot.network}>{children}</NetworkContext>
    </LiveConsoleContext>
  );
}

/** For pages outside the live console (the public scorecard) that still link to the explorer. */
export function NetworkProvider({ network, children }: { network: ConsoleNetwork; children: ReactNode }) {
  return <NetworkContext value={network}>{children}</NetworkContext>;
}

export function useLiveConsole(): LiveConsoleValue {
  const value = use(LiveConsoleContext);
  if (!value) throw new Error("useLiveConsole must be used inside <LiveConsoleProvider>");
  return value;
}

export function useSnapshot(): ConsoleSnapshot {
  return useLiveConsole().snapshot;
}

/** The console's network, or null outside any provider (component gallery): no explorer links then. */
export function useNetwork(): ConsoleNetwork | null {
  return use(NetworkContext);
}
