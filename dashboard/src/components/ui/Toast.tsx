"use client";

import { Toast, ToastClose, ToastDescription, ToastRegion, ToastTitle, toast } from "@ui-sdk/react/toast";
import { X } from "lucide-react";
import type { ReactNode } from "react";

import styles from "./Toast.module.css";

export type ToastTone = "neutral" | "success" | "held" | "danger" | "info";

export interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Milliseconds before it leaves on its own. Pauses while hovered or focused. */
  duration?: number;
}

const TYPES = {
  neutral: "default",
  success: "success",
  held: "warning",
  danger: "error",
  info: "info",
} as const;

function push(input: ToastInput) {
  toast({
    title: input.title,
    ...(input.description === undefined ? {} : { description: input.description }),
    type: TYPES[input.tone ?? "neutral"],
    duration: input.duration ?? 5000,
  });
}

/**
 * Toasts confirm what just happened ("Agent paused"). They never carry the only copy of
 * information: everything they say is also visible in the view that changed.
 */
export function useToast() {
  return push;
}

/** The page's one notification region, bottom right; F6 moves focus into it and back. */
export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <ToastRegion
        className={styles.region}
        side="bottom"
        align="end"
        maxVisible={3}
        aria-label="Notifications"
      >
        {() => (
          <Toast className={styles.toast}>
            <span className={styles.lamp} aria-hidden />
            <span className={styles.text}>
              <ToastTitle className={styles.title} />
              <ToastDescription className={styles.description} />
            </span>
            <ToastClose className={styles.close} aria-label="Dismiss notification">
              <X aria-hidden strokeWidth={2} />
            </ToastClose>
          </Toast>
        )}
      </ToastRegion>
    </>
  );
}
