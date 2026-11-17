import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { cx } from "@/lib/cx";

import styles from "./ArrowLink.module.css";
import { ViewLink } from "./ViewLink";

/** A short "go to" link for a card header: "All activity", "Rules". */
export function ArrowLink({
  href,
  children,
  className,
  view = false,
}: {
  href: string;
  children: ReactNode;
  className?: string;
  /** `href` is a view of the page's mandate (`/rules`), not a path of the site. */
  view?: boolean;
}) {
  const Target = view ? ViewLink : Link;
  return (
    <Target href={href} className={cx(styles.link, className)}>
      {children}
      <ArrowRight aria-hidden strokeWidth={2} />
    </Target>
  );
}
