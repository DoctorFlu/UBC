"use client";

import Link from "next/link";
import type { ComponentProps } from "react";

import { useMandateUrls } from "@/lib/mandate/MandateContext";

/** A link to a view of the page's own mandate: `href="/rules"` opens `/m/<id>/rules` (#95). */
export function ViewLink({ href, ...rest }: Omit<ComponentProps<typeof Link>, "href"> & { href: string }) {
  const urls = useMandateUrls();
  return <Link href={urls.href(href)} {...rest} />;
}
