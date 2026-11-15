"use client";

import { X } from "lucide-react";
import { type ReactNode, createContext, use, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cx } from "@/lib/cx";

import styles from "./Toast.module.css";

export type ToastTone = "neutral" | "success" | "held" | "danger" | "info";

export interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Milliseconds before it leaves on its own. Pauses while hovered or focused. */
  duration?: number;
}

interface ToastItem extends Required<Pick<ToastInput, "title" | "tone" | "duration">> {
  id: number;
  description: string | undefined;
}

const ToastContext = createContext<((toast: ToastInput) => void) | null>(null);

/**
 * Toasts confirm what just happened ("Agent paused"). They never carry the only copy of
 * information: everything they say is also visible in the view that changed.
 */
export function useToast() {
  const push = use(ToastContext);
  if (!push) throw new Error("useToast must be used inside <ToastProvider>");
  return push;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback((input: ToastInput) => {
    const id = nextId.current++;
    setToasts((current) => [
      ...current.slice(-2),
      {
        id,
        title: input.title,
        description: input.description,
        tone: input.tone ?? "neutral",
        duration: input.duration ?? 5000,
      },
    ]);
  }, []);

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext value={value}>
      {children}
      <div className={styles.region} role="region" aria-label="Notifications">
        <ol aria-live="polite" aria-relevant="additions" style={{ display: "contents" }}>
          {toasts.map((toast) => (
            <ToastView key={toast.id} toast={toast} onDismiss={dismiss} />
          ))}
        </ol>
      </div>
    </ToastContext>
  );
}

function ToastView({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return undefined;
    const timer = setTimeout(() => onDismiss(toast.id), toast.duration);
    return () => clearTimeout(timer);
  }, [paused, toast.duration, toast.id, onDismiss]);

  return (
    <li
      className={cx(styles.toast, toast.tone !== "neutral" && styles[toast.tone])}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className={styles.lamp} aria-hidden />
      <span className={styles.text}>
        <span className={styles.title}>{toast.title}</span>
        {toast.description ? <span className={styles.description}>{toast.description}</span> : null}
      </span>
      <button
        type="button"
        className={styles.close}
        aria-label="Dismiss notification"
        onClick={() => onDismiss(toast.id)}
      >
        <X aria-hidden strokeWidth={2} />
      </button>
    </li>
  );
}
