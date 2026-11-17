---
version: 1
slug: "site-src-app"
primary_target: "site/src/app"
related_targets: []
---

Scope: the public landing page (static export) that hands off to the console. Mode: Persuade.
Audience and job: hackathon judges and crypto-literate owners deciding in seconds whether an AI trading agent can be trusted behind Mandate; the action is "Launch app" (console origin) or "See a live scorecard".
Proof: the gate runs the product's own rule check (`evaluateIntent` from `@mandate/shared/rules`) against the demo mandate; red-team numbers from redteam/REPORT.md (16 Nov 2026); tool names from agent/src/tools.
Constraints: brief-pinned section order and structure (Catena for structure and calm only); no claims beyond testnet and simulated fills; no eyebrows (craft floor ban); Martian Mono only for codes, tool names, symbols.
Unresolved: final public URLs of the console and the scorecard agent (build-time settings).

## Direction contract

THESIS: Your agent is on a circuit and you hold the breaker. The page is one live breaker schedule the visitor can load, not a feature tour; it refuses the category default of a dark crypto hero with glowing gradients and a feature-card grid.

OWN-WORLD: The console's distribution board extended to a public face: switchgear grey ground, white schedule cards with 1px hairlines and small radii, anthracite in dark; color only in indicator lamps (green approved, amber held, red rejected); ink primary actions; Mona Sans condensed bold for display, normal width for prose; Martian Mono only for reason codes, tool names and market symbols; meters graduated with ticks; breaker glyphs with a handle that trips.

STORY: In five seconds the visitor drags a trade size and watches the contract's answer change from approved to held to rejected, with the rule that stopped it. They then see how the agent proposes, what they can check, what only their wallet can do, and launch the console.

FIRST VIEWPORT: Desktop: left 5 columns, a two-line condensed headline ("Your agent trades. / You hold the breaker."), one sentence, ink "Launch app" plus a text link to the live scorecard, a one-line testnet note. Right 7 columns, the gate card at full height: trade controls on top (slider graduated with the $20 and $25 marks, typed amount, market, pause switch), the schedule of six breakers in contract order wired by one bus line, and the verdict lamp at the foot. Phone: headline, sentence, actions, then the gate full width.

FORM: The established distribution-board world (console direction e85f64b4), extended to a Persuade surface; brief-pinned structure, so no concept roll was run.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
