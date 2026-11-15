---
version: 1
slug: "src-app"
primary_target: "src/app"
related_targets: []
---

Scope: the console shell (navigation, design system, wallet) plus placeholder views. Mode: Operate.
Audience and job: the owner watches an AI agent trade with their money; approves held intents; pauses it. Judges see it on a projector and a phone.
Unresolved: final product name ("Mandate" is a working title); WalletConnect project id.

## Direction contract

THESIS: The mandate is a distribution board. Each rule is a circuit with a rating (its limit) and a live load; a rejection is a trip; the kill switch is the main isolator. Refuses the category default of a neon trading dashboard or a hero-metric card grid.

OWN-WORLD: Switchgear light grey ground (RAL 7035 family) with white schedule-card surfaces and graphite ink; dark theme is anthracite enclosure grey (RAL 7016 family), never near-black. Color is reserved for indicator lamps (IEC 60073 sense): green approved, amber held, red rejected, blue filled, hollow neutral unfilled. Paused is the isolator off: inverse ink band. Mona Sans with its width axis: condensed for ratings, headings and figures, normal for body; Martian Mono only for hashes, addresses and reason codes. 1px hairline rules, small radii, no gradients, no glass.

STORY: The owner sees at once whether the agent is live, how much load each rule carries, and what needs them. They act on held intents and can open the isolator from any screen.

FIRST VIEWPORT: Desktop: panel-door sidebar (directory nav, compact schedule of limits, wallet) and a status strip with the live-source lamp, isolator and wallet. Overview leads with the panel schedule: one row per rule with lamp, rating, load meter graduated in ticks, and trips today; held intents sit beside it. Phone: top bar with lamp, isolator and menu; schedule stacks first.

FORM: Electrical distribution board; position 5 of 7 on the grounded list; seed key e85f64b4. Raises: strict state vocabulary used identically everywhere (from transit diagram); fixed rem type scale, no fluid type (from bitmap specimen); held rows take focus while settled rows recede (from title wall); 1px hairlines and a limited value range (from centre rail); a strict 4px spacing grid (from Crouwel grid); live rows keep fixed columns and state restyles the row, never the grid (from split-flap board, competitive).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
