# @mandate/shared

Types, the Policy contract ABI and a typed client, shared by the agent, the console and the executor.
The production contract `contracts/src/Policy.sol` is the source of truth; the devchain tests prove this package matches it.

## What is in it

| Module | Purpose |
| --- | --- |
| `abi.ts` | `policyBaseAbi` (exactly `Policy.sol`), `policyExtensionsAbi` (the additions requested in `docs/contract-interface.md`), and `policyAbi` (both). |
| `types.ts` | zod schemas and types: `PolicyRules`, `TradeIntentInput`, `Intent`, `PolicyEvent`. |
| `reasons.ts` | Verdicts, intent statuses and the contract's exact rejection strings, each with a label and a one-sentence explanation. |
| `evaluate.ts` | `evaluateIntent` and `headroom`: the contract's rules in TypeScript, fuzz-tested against the real contract. |
| `events.ts`, `reducer.ts` | Decode logs and rebuild the contract's state from events (deterministic, idempotent, order independent). |
| `client.ts` | `PolicyClient`: reads, previews, event polling and one method per role action. |
| `chains.ts`, `deployment.ts` | Arc testnet and devchain definitions, explorer links, the devchain deployment file schema. |
| `context.ts` | `hashContext`: keccak256 of the canonical JSON of an agent's decision context. |
| `categories.ts`, `units.ts`, `fees.ts` | Category bitmask, cents and quantities, the Arc fee floor. |

Node-only helpers (`resolvePolicyDeployment`, `createPolicyClient`) are in `@mandate/shared/node`.

## Using the client

```ts
import { describeReason } from "@mandate/shared";
import { createPolicyClient } from "@mandate/shared/node";

// POLICY_ADDRESS set: Arc testnet. Otherwise: the local devchain from `npm run dev:chain`.
const policy = createPolicyClient({ account }); // account decides which role methods succeed

const preview = await policy.previewTrade({ category: 0, isBuy: true, amountCents: 1_000 });
const result = await policy.proposeTrade({
  market: "GEMI-BTC2611202200-HI65000",
  category: 0,
  outcome: "YES",
  isBuy: true,
  amountCents: 1_000,
  limitPrice: 65,
});
if (result.verdict === "rejected") console.log(describeReason(result.reason).explanation);
```

A rejection is a result, not an error.
Writes that the contract refuses (wrong role, wrong status) throw `PolicyRevertError` with the contract's error name.

The client works with the production contract alone.
It detects the optional additions with read-only probes: without `previewTrade` it previews with `evaluateIntent` (`source: "offchain"`), and without the `contextHash` overload it reports `contextHashRecorded: false`.
Without `IntentProposed`, the reducer leaves intent details null; `intentsMissingDetails` and `mergeIntentDetails` fill them from `getIntent`.

## Tests

```bash
npx vitest run shared      # unit tests, no chain needed
npx vitest run devchain    # the same code against both contracts on anvil
```
