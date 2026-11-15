"use client";

import { Play, Power } from "lucide-react";

import { HoldButton } from "@/components/ui/HoldButton";
import { useToast } from "@/components/ui/Toast";

import { useConsoleState } from "./ConsoleState";
import styles from "./Shell.module.css";

/**
 * The kill switch, reachable from every screen. Hold to pause (or press twice). Mock for now:
 * #15 sends `setPaused` to the Policy contract and the state then comes back from chain events.
 */
export function Isolator({ size = "md" }: { size?: "sm" | "md" }) {
  const { paused, setPaused } = useConsoleState();
  const toast = useToast();

  if (paused) {
    return (
      <HoldButton
        tone="ink"
        size={size}
        icon={<Play aria-hidden />}
        confirmedLabel="Resumed"
        onConfirm={() => {
          setPaused(false);
          toast({
            title: "Agent resumed",
            description: "New intents are checked against the mandate again.",
          });
        }}
      >
        <span className={styles.longLabel}>Resume agent</span>
        <span className={styles.shortLabel}>Resume</span>
      </HoldButton>
    );
  }

  return (
    <HoldButton
      tone="danger"
      size={size}
      icon={<Power aria-hidden />}
      confirmedLabel="Paused"
      onConfirm={() => {
        setPaused(true);
        toast({
          title: "Agent paused",
          description: "The Policy contract now rejects every new intent.",
          tone: "danger",
        });
      }}
    >
      <span className={styles.longLabel}>Pause agent</span>
      <span className={styles.shortLabel}>Pause</span>
    </HoldButton>
  );
}
