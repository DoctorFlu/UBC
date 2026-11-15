import type { Metadata } from "next";

import { GalleryView } from "@/features/component-gallery";

export const metadata: Metadata = { title: "Components", robots: { index: false } };

export default function ComponentsPage() {
  return <GalleryView />;
}
