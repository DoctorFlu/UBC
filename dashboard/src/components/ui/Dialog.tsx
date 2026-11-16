"use client";

import {
  Dialog as DialogRoot,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@ui-sdk/react/dialog";
import {
  Drawer,
  DrawerBackdrop,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from "@ui-sdk/react/drawer";
import { X } from "lucide-react";
import type { ReactNode } from "react";

import { cx } from "@/lib/cx";

import styles from "./Dialog.module.css";

export interface DialogProps {
  open: boolean;
  /** Called for Escape, the close button, and a press outside when `lightDismiss` allows it. */
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** "dialog" is centered; "sheet" rises from the bottom on phones; "drawer" slides from the start edge. */
  variant?: "dialog" | "sheet" | "drawer";
  /** Close on a press outside the panel. Off for anything with unsaved input. */
  lightDismiss?: boolean;
  className?: string;
}

/** A modal for tasks that need protected focus: the page goes inert and focus returns to the opener. */
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
  const onOpenChange = (next: boolean) => {
    if (!next) onClose();
  };

  if (variant === "drawer") {
    return (
      <Drawer open={open} onOpenChange={onOpenChange} side="start" closeOnOutsidePress={lightDismiss}>
        <DrawerBackdrop className={styles.backdrop} />
        <DrawerContent className={cx(styles.dialog, styles.drawer, className)}>
          <header className={styles.header}>
            <div>
              <DrawerTitle className={styles.title}>{title}</DrawerTitle>
              {description !== undefined ? (
                <DrawerDescription className={styles.description}>{description}</DrawerDescription>
              ) : null}
            </div>
            <DrawerClose className={styles.close} aria-label="Close">
              <X aria-hidden strokeWidth={2} />
            </DrawerClose>
          </header>
          {children !== undefined ? <div className={styles.body}>{children}</div> : null}
          {footer !== undefined ? <footer className={styles.footer}>{footer}</footer> : null}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange} closeOnOutsidePress={lightDismiss}>
      <DialogBackdrop className={styles.backdrop} />
      <DialogContent className={cx(styles.dialog, variant === "sheet" && styles.sheet, className)}>
        <header className={styles.header}>
          <div>
            <DialogTitle className={styles.title}>{title}</DialogTitle>
            {description !== undefined ? (
              <DialogDescription className={styles.description}>{description}</DialogDescription>
            ) : null}
          </div>
          <DialogClose className={styles.close} aria-label="Close">
            <X aria-hidden strokeWidth={2} />
          </DialogClose>
        </header>
        {children !== undefined ? <div className={styles.body}>{children}</div> : null}
        {footer !== undefined ? <footer className={styles.footer}>{footer}</footer> : null}
      </DialogContent>
    </DialogRoot>
  );
}
