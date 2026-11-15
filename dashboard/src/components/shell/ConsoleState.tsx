"use client";

import { type ReactNode, createContext, use, useMemo, useState } from "react";

/**
 * App-wide console state the shell reacts to. For now `paused` is a local mock toggle; #15 wires
 * it to the Policy contract's `setPaused` and #14 feeds it from chain events.
 */
interface ConsoleStateValue {
  paused: boolean;
  setPaused: (paused: boolean) => void;
}

const ConsoleStateContext = createContext<ConsoleStateValue | null>(null);

export function ConsoleStateProvider({
  initialPaused,
  children,
}: {
  initialPaused: boolean;
  children: ReactNode;
}) {
  const [paused, setPaused] = useState(initialPaused);
  const value = useMemo(() => ({ paused, setPaused }), [paused]);
  return <ConsoleStateContext value={value}>{children}</ConsoleStateContext>;
}

export function useConsoleState(): ConsoleStateValue {
  const value = use(ConsoleStateContext);
  if (!value) throw new Error("useConsoleState must be used inside <ConsoleStateProvider>");
  return value;
}
