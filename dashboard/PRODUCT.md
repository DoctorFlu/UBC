# Product

<!-- impeccable:product-schema 1 -->

Inferred from the task brief and GitHub issues #13 and #30; no separate interview round was run.

## Platform

web

## Users

The owner: a crypto-literate person who lets an AI agent (Grok Bot, connected over MCP) trade Gemini prediction markets with their money.
They write a mandate once, watch every trade intent, approve or reject the ones held for them, and pause the agent when something looks wrong.
They use the console on a laptop and on a phone, often away from a desk when an approval arrives.
A second audience reads the public agent scorecard without a wallet.
For the hackathon, judges watch it live on a projector and on a phone.

## Product Purpose

A control panel for an AI agent that trades with the owner's money.
Every trade intent is a transaction to a Policy contract on Arc, which approves it, rejects it with a reason code, or holds it for the owner's wallet signature.
The console is where the owner sets the mandate, watches intents live, approves or rejects held ones, hits a kill switch, sees the hedge payoff, and reads an audit trail that can be verified onchain.
Success: the owner always knows what the agent did, why, and under which rule, and can stop it in one action.

## Positioning

The mandate is onchain: anyone can read the rules an agent runs under and every verdict it received.
Verdicts, not errors: approved, held, or rejected with a reason code.
Risk rules (daily loss limit, budget, max order size), a backtest of a draft mandate, sealed decision context, a public scorecard, and one kill switch.

## Voice

Plain, specific, sentence case.
No marketing fluff, no hype, no gamification.
The feeling is a calm, precise risk desk: not a casino, not a generic crypto dashboard with neon gradients.

## Constraints

- Light and dark themes, both intentional; AA contrast in both.
- Responsive from 360 px phones to a projector; the approve flow and the kill switch must be comfortable on a phone.
- Money is integer cents in, exact strings out, with tabular numerals.
- Never use the em dash character.
