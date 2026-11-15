import { LoaderCircle } from "lucide-react";
import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from "react";

import { cx } from "@/lib/cx";

import styles from "./Button.module.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "dangerOutline";
export type ButtonSize = "sm" | "md" | "lg";

interface StyleProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  /** Square button with only an icon; pass an aria-label. */
  iconOnly?: boolean;
}

export function buttonClass(
  { variant = "secondary", size = "md", block, iconOnly }: StyleProps,
  extra?: string,
) {
  return cx(
    styles.button,
    styles[variant],
    size !== "md" && styles[size],
    block && styles.block,
    iconOnly && styles.iconOnly,
    extra,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, StyleProps {
  icon?: ReactNode;
  /** Shows a spinner, keeps the width, and blocks clicks. */
  loading?: boolean;
}

export function Button({
  variant,
  size,
  block,
  iconOnly,
  icon,
  loading = false,
  disabled,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClass({ variant, size, block, iconOnly }, className)}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <LoaderCircle className={styles.spinner} aria-hidden /> : icon}
      {children}
    </button>
  );
}

export interface ButtonLinkProps extends ComponentProps<typeof Link>, StyleProps {
  icon?: ReactNode;
}

export function ButtonLink({
  variant,
  size,
  block,
  iconOnly,
  icon,
  className,
  children,
  ...rest
}: ButtonLinkProps) {
  return (
    <Link className={buttonClass({ variant, size, block, iconOnly }, className)} {...rest}>
      {icon}
      {children}
    </Link>
  );
}
