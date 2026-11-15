"use client";

import { X } from "lucide-react";
import { type ReactNode, useEffect, useEffectEvent, useId, useRef } from "react";

import { cx } from "@/lib/cx";

import styles from "./Dialog.module.css";

export interface DialogProps {
  open: boolean;
  /** Called for Escape, the close button, a backdrop click, and `<form method="dialog">` buttons. */
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** "dialog" is centered; "sheet" rises from the bottom on phones; "drawer" slides from the left. */
  variant?: "dialog" | "sheet" | "drawer";
  /** Close on a click outside the panel. Off for anything with unsaved input. */
  lightDismiss?: boolean;
  className?: string;
}

/**
 * A native modal <dialog>: the browser handles focus containment, the inert page, Escape,
 * and returning focus to the opener. Use it only for tasks that need protected focus.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  variant = "dialog",
  lightDismiss = true,
  className,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const handleClose = useEffectEvent(onClose);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return undefined;
    const onCloseEvent = () => handleClose();
    // Light dismiss for browsers without `closedby`: a press and release both outside the panel.
    let pressedOutside = false;
    const outside = (event: PointerEvent) => {
      const rect = dialog.getBoundingClientRect();
      return (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      );
    };
    const onPointerDown = (event: PointerEvent) => {
      pressedOutside = lightDismiss && outside(event);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (pressedOutside && outside(event)) dialog.close();
      pressedOutside = false;
    };
    dialog.addEventListener("close", onCloseEvent);
    dialog.addEventListener("pointerdown", onPointerDown);
    dialog.addEventListener("pointerup", onPointerUp);
    return () => {
      dialog.removeEventListener("close", onCloseEvent);
      dialog.removeEventListener("pointerdown", onPointerDown);
      dialog.removeEventListener("pointerup", onPointerUp);
    };
  }, [lightDismiss]);

  return (
    <dialog
      ref={ref}
      className={cx(styles.dialog, variant !== "dialog" && styles[variant], className)}
      aria-labelledby={titleId}
      aria-describedby={description !== undefined ? descriptionId : undefined}
    >
      <div className={styles.inner}>
        <header className={styles.header}>
          <div>
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
            {description !== undefined ? (
              <p id={descriptionId} className={styles.description}>
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            className={styles.close}
            aria-label="Close"
            onClick={() => ref.current?.close()}
          >
            <X aria-hidden strokeWidth={2} />
          </button>
        </header>
        {children !== undefined ? <div className={styles.body}>{children}</div> : null}
        {footer !== undefined ? <footer className={styles.footer}>{footer}</footer> : null}
      </div>
    </dialog>
  );
}
