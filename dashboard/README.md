# Dashboard

The owner's console for Mandate: set the mandate, watch intents, approve or reject held ones, pause the agent, and read the hedge, payments and audit trail.
It also serves a public, wallet-free scorecard at `/agent/[address]`.

This package is the frame only.
Every view renders typed mock data from `src/mock`, and later issues replace that data with real sources.

## Stack

- Next.js 16 (App Router, Turbopack), React 19, TypeScript in strict mode.
- It runs as a long-lived Node server (`next start`), not a static export, because later issues add webhook and server-sent events routes.
- wagmi and viem with the injected connector, on Arc testnet or a local anvil chain.
- CSS Modules on top of one token file, `src/styles/tokens.css`.
  There is no CSS framework and no component library.
- The Next.js docs that match the installed version are in `node_modules/next/dist/docs/`.
  Read those rather than relying on memory, because Next.js 16 changed several APIs (async `params`, no `next lint`, Turbopack by default).

## Commands

Run these from the repository root.

```sh
npm install
npm run dev -w @mandate/dashboard        # http://localhost:3000
npm run check                            # lint, format, typecheck and unit tests for every workspace
npx playwright install chromium          # once, before the first e2e run
npm run e2e                              # Playwright smoke test against next dev
npm run screenshots                      # production build, then every route into docs/screenshots
```

Use `http://localhost`, not `http://127.0.0.1`.
The dev server's hot-reload socket only accepts the host it was started on.

Never run `next build` (or `npm run screenshots`) while `next dev` is running from this folder, because both write to `.next`.

## Environment

| Variable                 | Values                         | Effect                                                                     |
| ------------------------ | ------------------------------ | -------------------------------------------------------------------------- |
| `NEXT_PUBLIC_CHAIN`      | `arc-testnet` (default), `local` | Arc testnet, or anvil at `http://127.0.0.1:8545` with the same chain id. |
| `NEXT_PUBLIC_DEV_SIGNER` | unset (default), `1`           | Adds a test-only signer that connects as anvil account #0.                 |

Both chains use chain id 5042002 and native USDC with 18 decimals.
The chain config lives in `src/lib/chain.ts` and moves to `@mandate/shared` once that package lands.

### Dev signer

With `NEXT_PUBLIC_DEV_SIGNER=1` the console connects automatically as the owner, so tests and local demos need no browser wallet.
It signs with anvil's account #0, which is a public test key that anyone can use.
Never send real funds to its address.

A dashed "Dev signer" badge shows in the status strip whenever it is on.
Without the flag the build contains neither the connector nor the key.
To check a build, run this after `next build` without the flag; it should print nothing:

```sh
grep -rl ac0974bec39a dashboard/.next/static dashboard/.next/server --include=*.js
```

WalletConnect is not wired up, because it needs a project id.
`src/lib/wallet/config.ts` marks where it plugs in.

## Structure

```text
src/
  app/
    (console)/            owner views, inside the shell and the wallet provider
      <view>/page.tsx     one route folder per view
    (public)/agent/[address]/   the public scorecard, no wallet
    dev/components/       the component gallery
  features/<view>/        one folder per view: <View>View.tsx, <view>.module.css, index.ts
  components/
    ui/                   shared primitives, shown at /dev/components
    domain/               small pieces that know the domain (market name, approval actions)
    shell/                the console frame: sidebar, status strip, wallet, isolator
    states/               view-level loading and error frames
  lib/                    formatters, hold-to-confirm logic, chain, wallet, domain types
  mock/                   every piece of mock data, typed
  styles/tokens.css       color, type, spacing, radius and motion tokens for both themes
```

### Adding a view

1. Create `src/features/<view>/` with a `<View>View.tsx` that takes its data as props, a `<view>.module.css`, and an `index.ts` that exports the view.
2. Create `src/app/(console)/<view>/page.tsx`.
   It reads the data (from `@/mock` for now), handles `?state=loading|empty|error` with `previewState`, `ViewSkeleton` and `ViewError`, and renders the view.
3. Add the route to `src/lib/nav.ts` and to `e2e/routes.ts`.
4. Build from `@/components/ui`.
   Views compose primitives and do not restyle them.
   If a view needs something new, add it to `components/ui` and to the gallery.
5. Money is integer cents everywhere.
   Format it with `src/lib/format.ts` or the `Money` component, never with floating point.

Only `page.tsx` files import `@/mock`.
When real data lands, the page swaps its source and the view does not change.

## Design

The console is a distribution board for a trading agent.
The mandate's rules are drawn as rated circuits with their load, the kill switch is the isolator in the status strip, and color is kept for the status lamps.
Both themes are designed: switchgear grey in light, anthracite in dark.
Type is Mona Sans (variable width) for everything, with Martian Mono only for hashes, addresses and reason codes.
Both fonts are self-hosted under the SIL Open Font License.

The quality bar for every change:

- AA contrast in both themes, visible focus, full keyboard support, and `prefers-reduced-motion` respected.
- No layout shift, no hydration warnings, and no console errors.
  The smoke test fails on any console error or warning.
- It works at 360 px and on a projector.
  The approve flow and the kill switch are sized for a thumb.
- Destructive or signing actions use `HoldButton`.
  It confirms on a 1.2 second hold, or on two presses for keyboards, switches and screen readers.

## Screenshots

`npm run screenshots` writes every route at 390 px and 1440 px, in light and dark, to `docs/screenshots/`.
