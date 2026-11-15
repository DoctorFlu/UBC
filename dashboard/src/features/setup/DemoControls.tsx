"use client";

import { useConsoleState } from "@/components/shell/ConsoleState";
import { Toggle } from "@/components/ui/Toggle";

/** Mock switches for rehearsing the demo. They change only this browser tab's view. */
export function DemoControls() {
  const { paused, setPaused } = useConsoleState();
  return (
    <Toggle
      label="Show the agent as paused"
      description="Turns on the paused banner across the console without touching the contract."
      checked={paused}
      onChange={setPaused}
    />
  );
}
