/**
 * Where the app icons live. `brand/icons/` holds the source; each app keeps a copy in its `app/` folder,
 * where Next's icon file conventions find it. Copies, not symbolic links: Next resolves a link to its
 * target and then no longer treats `favicon.ico` as the favicon. `npm run icons -w @mandate/brand` writes
 * all of them, and `brand/icons.test.ts` fails when a copy differs from the source.
 */
import { fileURLToPath } from "node:url";

export const ICON_FILES = ["favicon.ico", "icon.svg", "apple-icon.png"] as const;

export const ICON_SOURCE = fileURLToPath(new URL("../icons/", import.meta.url));

export const ICON_COPIES = [
  fileURLToPath(new URL("../../site/src/app/", import.meta.url)),
  fileURLToPath(new URL("../../dashboard/src/app/", import.meta.url)),
];
