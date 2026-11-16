import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { cx } from "@/lib/cx";

import styles from "./ArrowLink.module.css";

/** A short "go to" link for a card header: "All activity", "Rules". */
export function ArrowLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link href={href} className={cx(styles.link, className)}>
      {children}
      <ArrowRight aria-hidden strokeWidth={2} />
    </Link>
  );
}
