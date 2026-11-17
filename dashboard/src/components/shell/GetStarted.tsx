"use client";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { Meter, MeterIndicator, MeterTrack } from "@ui-sdk/react/meter";
import { Check, ChevronUp, X } from "lucide-react";
import { ViewLink } from "@/components/ui/ViewLink";
import { usePathname } from "next/navigation";
import { useState, useSyncExternalStore } from "react";

import { useSnapshot } from "@/lib/live/LiveConsole";
import { isActive } from "@/lib/nav";
import { useOwnerAccess } from "@/lib/owner/access";
import { setupSteps } from "@/lib/setup";

import styles from "./GetStarted.module.css";

const DISMISSED_KEY = "mandate-get-started-hidden";
const listeners = new Set<() => void>();
let hiddenThisPage = false;

function readHidden(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function hide() {
  try {
    localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // Storage can be blocked; the checklist still hides until the page reloads.
  }
  hiddenThisPage = true;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * A small "Get started" checklist above the sidebar's footer while setup is incomplete. It reads the same
 * live steps as the Setup page, and the owner can hide it for good; Setup itself stays in the navigation.
 */
export function GetStarted() {
  const snapshot = useSnapshot();
  const access = useOwnerAccess();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const hidden = useSyncExternalStore(
    subscribe,
    () => hiddenThisPage || readHidden(),
    () => true,
  );
  const steps = setupSteps(snapshot, access.kind === "owner");
  const done = steps.filter((step) => step.done).length;
  if (hidden || access.kind === "loading" || done === steps.length || isActive(pathname, "/setup")) {
    return null;
  }
  const next = steps.find((step) => !step.done);

  return (
    <section className={styles.dock} aria-label="Get started" data-testid="get-started">
      <Collapsible open={open} onOpenChange={setOpen} className={styles.card}>
        <div className={styles.head}>
          <CollapsibleTrigger className={styles.trigger}>
            <span className={styles.title}>Get started</span>
            <span className={styles.count}>
              {done}/{steps.length}
            </span>
            <ChevronUp aria-hidden className={styles.chevron} nonScalingStroke strokeWidth={2} />
          </CollapsibleTrigger>
          <button type="button" className={styles.hide} aria-label="Hide the setup checklist" onClick={hide}>
            <X aria-hidden nonScalingStroke strokeWidth={2} />
          </button>
        </div>
        <Meter
          className={styles.meter}
          value={done}
          min={0}
          max={steps.length}
          aria-label="Setup progress"
          getValueLabel={() => `${done.toString()} of ${steps.length.toString()} steps done`}
        >
          <MeterTrack className={styles.track}>
            <MeterIndicator className={styles.fill} />
          </MeterTrack>
        </Meter>
        <CollapsiblePanel className={styles.panel}>
          <ol className={styles.steps}>
            {steps.map((step) => (
              <li key={step.id} className={styles.step} data-done={step.done || undefined}>
                <span className={styles.marker} aria-hidden>
                  {step.done ? <Check nonScalingStroke strokeWidth={2} /> : null}
                </span>
                <span>
                  {step.title}
                  <span className="visually-hidden">{step.done ? " (done)" : " (to do)"}</span>
                </span>
              </li>
            ))}
          </ol>
          <ViewLink href="/setup" className={styles.link} onClick={() => setOpen(false)}>
            {next ? `Next: ${next.title}` : "Open setup"}
          </ViewLink>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}
