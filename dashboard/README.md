# Dashboard

The owner's console for Mandate: set the mandate, watch intents, approve or reject held ones, pause the agent, and read the hedge, payments and audit trail.
It also serves a public, wallet-free scorecard at `/agent/[address]`.

It reads the Policy contract's events into a durable store, pushes every change to the browser over server-sent events, and serves the agent API the MCP server calls (`shared/src/console-api.ts`).
The owner signs the mandate, approvals, rejections and the kill switch with their own wallet; the console never holds a key.

Every view shows real data.
The hedge view shows the agent's latest stored plan per asset, which intents carried it out, and Gemini's live ladder, which the console fetches from Gemini's public read-only API and caches for 10 seconds; the browser never calls Gemini.
With no plan it says how to get one and shows a preview from the same planner, labelled as a preview.
The payments view shows the signal payments and the signal budget the MCP server reports.
Each plan has an evidence chain at `/hedge/plans/[planId]`, reached from the hedge page and from an intent's sealed reason.
It links, in order, the owner's request, the paid signal, the plan, and each intent with the contract's verdict, the owner's decision and the fill.
It is "verified" only when every intent's stored reason hashes to the chain and names the plan and its signal; a tampered reason, an intent with no checkable reason, or a reason that does not name the signal is said in plain words instead.

The public scorecard shows the mandate, intents by verdict at proposal, blocked attempts by rule, the owner's approvals and rejections, fills and the realized result.
Every number is computed from the Policy contract's events, matches the audit trail (a unit test and the smoke test hold it to that), and lists the transactions behind it.
It gets nothing offchain (no holdings, plans, reasons or payments), links nowhere into the console, clips onchain strings, and is computed once per chain update however often it is loaded.

## Stack

- Next.js 16 (App Router, Turbopack), React 19, TypeScript in strict mode.
- It runs as a long-lived Node server (`next start`), not a static export: it polls the chain, receives the QuickNode Stream webhook and holds server-sent event connections.
- SQLite through Node's built-in `node:sqlite` for the console's store (events, decision contexts, holdings, hedge plans, pairing, change requests, signal payments and the signal budget).
- wagmi and viem with the injected connector, on Arc testnet or a local anvil chain.
- CSS Modules on top of one token file, `src/styles/tokens.css`.
  There is no CSS framework and no component library.
- The Next.js docs that match the installed version are in `node_modules/next/dist/docs/`.
  Read those rather than relying on memory, because Next.js 16 changed several APIs (async `params`, no `next lint`, Turbopack by default).

## Commands

Run these from the repository root.

```sh
npm install
npm run dev:chain                        # terminal 1: anvil with a Policy contract (see devchain/README.md)
npm run dev -w @mandate/dashboard        # terminal 2: http://localhost:3000
npm run check                            # lint, format, typecheck and unit tests for every workspace
npx playwright install chromium          # once, before the first e2e run
npm run e2e                              # smoke suite, then the live owner flow, each on its own chain
npm run screenshots                      # production build, then every route into docs/screenshots
```

Use `http://localhost`, not `http://127.0.0.1`.
The dev server's hot-reload socket only accepts the host it was started on.

Never run `next build` (or `npm run screenshots`) while `next dev` is running from this folder, because both write to `.next`.

### End-to-end tests

The tests never touch Arc or your own data.
Each suite starts anvil with the production Policy contract and its own console data folder under `.data/e2e-<suite>/`:

- `smoke` (port 3100, chain 8645) seeds a demo history with every verdict, plays the MCP server once (announces the agent and links a decision context), then checks every route in both themes at 390 px and 1440 px.
- `live` (port 3102, chain 8646) starts from an empty contract and runs the owner's loop: sign the first mandate, see a proposal within 2 seconds without a refresh, approve, reject, see a fill, pause, watch the contract refuse the next proposal, and restart the console to check it rebuilds identical state.
- `screenshots` uses the smoke seed on a production build.

Override the ports with `E2E_PORT`, `E2E_CHAIN_PORT`, `E2E_LIVE_PORT` and `E2E_LIVE_CHAIN_PORT` when they are taken.

## Environment

Every variable the console reads is in [docs/configuration.md](../docs/configuration.md).

The chain is decided at runtime, not at build time.
With `POLICY_ADDRESS` set the console follows that contract on Arc testnet; otherwise it follows the local devchain's deployment file.
Both chains use chain id 5042002 and native USDC with 18 decimals, and the browser's wallet follows whatever the server reports.

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
    (console)/            owner views, inside the shell, the live snapshot and the wallet provider
      <view>/page.tsx     one route folder per view
      hedge/plans/[planId]/   one plan's evidence chain
    (public)/agent/[address]/   the public scorecard, no wallet
    api/agent/v1/         the agent API (bearer token), see shared/src/console-api.ts
    api/console/          snapshot, server-sent events and owner-signed offchain writes
    api/webhooks/         the QuickNode Stream webhook
    dev/components/       the component gallery
  features/<view>/        one folder per view: <View>View.tsx, <view>.module.css, index.ts
  components/
    ui/                   shared primitives, shown at /dev/components
    domain/               small pieces that know the domain (market name, approval actions)
    shell/                the console frame: sidebar, status strip, wallet, isolator
    states/               view-level loading and error frames
  lib/                    formatters, hold-to-confirm logic, network, wallet
    live/                 the snapshot type, the live provider, and read-only derivations
    owner/                owner transactions and owner-signed requests
  server/                 the console backend: ingest, store, agent and owner routes
  fixtures/               typed fixtures for ?state= previews, the gallery and tests
  styles/tokens.css       color, type, spacing, radius and motion tokens for both themes
```

### Adding a view

1. Create `src/features/<view>/` with a client `<View>View.tsx` that reads `useSnapshot()` and accepts an optional `preview` snapshot, a `<view>.module.css`, and an `index.ts` that exports the view.
2. Create `src/app/(console)/<view>/page.tsx`.
   It handles `?state=loading|empty|error` with `previewState`, `ViewSkeleton` and `ViewError`, passes `emptyFixtureSnapshot` as `preview` for `empty`, and otherwise renders the view on live data.
3. Add the route to `src/lib/nav.ts` and to `e2e/routes.ts`.
4. Build from `@/components/ui`.
   Views compose primitives and do not restyle them.
   If a view needs something new, add it to `components/ui` and to the gallery.
5. Money is integer cents everywhere.
   Format it with `src/lib/format.ts` or the `Money` component, never with floating point.

Every view handles the states the chain can be in: still reading history, no Policy contract configured, the chain unreachable, no mandate yet, nothing to show yet, and a wallet that is not the owner.
Fixtures only ever appear in previews, the gallery and tests.

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
