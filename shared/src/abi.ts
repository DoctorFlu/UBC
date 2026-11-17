/**
 * ABIs of the Policy contract.
 *
 * - `policyAbi` matches the production contract (`contracts/src/Policy.sol`, v2 since issue #23) exactly.
 * - It is made of three parts. `policyBaseAbi` is what every Policy contract has, including the first
 *   production version. `policyExtensionsAbi` holds the additions requested in `docs/contract-interface.md`,
 *   which the production contract now has and the devchain reference contract has too; `PolicyClient`
 *   still detects them at runtime. `policyV2Abi` is what only the production contract has: `setUser`,
 *   the role events and `ZeroAddress`.
 * - `policyReferenceAbi` is the devchain reference contract's ABI: the base plus the extensions.
 *
 * `internalType` is left out so the ABI does not depend on Solidity type names. The devchain tests check
 * that the production contract compiles to exactly `policyAbi`, and the reference contract to exactly
 * `policyReferenceAbi`.
 */

const policyRulesComponents = [
  { name: "budgetCents", type: "uint256" },
  { name: "maxTradeCents", type: "uint256" },
  { name: "allowedCategories", type: "uint256" },
  { name: "approvalAboveCents", type: "uint256" },
  { name: "dailyLossCents", type: "uint256" },
  { name: "paused", type: "bool" },
] as const;

const policyRulesEventInputs = [
  { name: "budgetCents", type: "uint256", indexed: false },
  { name: "maxTradeCents", type: "uint256", indexed: false },
  { name: "allowedCategories", type: "uint256", indexed: false },
  { name: "approvalAboveCents", type: "uint256", indexed: false },
  { name: "dailyLossCents", type: "uint256", indexed: false },
  { name: "paused", type: "bool", indexed: false },
] as const;

const intentComponents = [
  { name: "market", type: "string" },
  { name: "category", type: "uint8" },
  { name: "outcome", type: "string" },
  { name: "isBuy", type: "bool" },
  { name: "amountCents", type: "uint256" },
  { name: "limitPrice", type: "uint256" },
  { name: "status", type: "uint8" },
  { name: "proposedAt", type: "uint64" },
  { name: "filledCents", type: "uint256" },
  { name: "pnlCents", type: "int256" },
] as const;

const proposeTradeInputs = [
  { name: "market", type: "string" },
  { name: "category", type: "uint8" },
  { name: "outcome", type: "string" },
  { name: "isBuy", type: "bool" },
  { name: "amountCents", type: "uint256" },
  { name: "limitPrice", type: "uint256" },
] as const;

const view = (name: string, type: string) =>
  ({
    type: "function",
    name,
    inputs: [],
    outputs: [{ name: "", type }],
    stateMutability: "view",
  }) as const;

/** What every Policy contract has, without the constructor. */
export const policyBaseAbi = [
  // ------------------------------------------------------------ user
  {
    type: "function",
    name: "setPolicy",
    inputs: [{ name: "p", type: "tuple", components: policyRulesComponents }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setPaused",
    inputs: [{ name: "paused_", type: "bool" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setAgent",
    inputs: [{ name: "agent_", type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setExecutor",
    inputs: [{ name: "executor_", type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "approveIntent",
    inputs: [{ name: "intentId", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "rejectIntent",
    inputs: [{ name: "intentId", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // ------------------------------------------------------------ agent
  {
    type: "function",
    name: "proposeTrade",
    inputs: proposeTradeInputs,
    outputs: [{ name: "intentId", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  // ------------------------------------------------------------ executor
  {
    type: "function",
    name: "recordResult",
    inputs: [
      { name: "intentId", type: "uint256" },
      { name: "filled", type: "bool" },
      { name: "filledCents", type: "uint256" },
      { name: "pnlCents", type: "int256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // ------------------------------------------------------------ views
  view("user", "address"),
  view("agent", "address"),
  view("executor", "address"),
  {
    type: "function",
    name: "policy",
    inputs: [],
    outputs: policyRulesComponents,
    stateMutability: "view",
  },
  view("committedCents", "uint256"),
  view("lossDay", "uint256"),
  view("dayLossCents", "uint256"),
  view("intentCount", "uint256"),
  {
    type: "function",
    name: "getIntent",
    inputs: [{ name: "intentId", type: "uint256" }],
    outputs: [{ name: "", type: "tuple", components: intentComponents }],
    stateMutability: "view",
  },
  view("remainingBudgetCents", "uint256"),
  view("lossTodayCents", "uint256"),
  // ------------------------------------------------------------ events
  { type: "event", name: "PolicyUpdated", inputs: policyRulesEventInputs, anonymous: false },
  {
    type: "event",
    name: "Paused",
    inputs: [{ name: "paused", type: "bool", indexed: false }],
    anonymous: false,
  },
  {
    type: "event",
    name: "IntentApproved",
    inputs: [
      { name: "intentId", type: "uint256", indexed: true },
      { name: "market", type: "string", indexed: false },
      { name: "outcome", type: "string", indexed: false },
      { name: "isBuy", type: "bool", indexed: false },
      { name: "amountCents", type: "uint256", indexed: false },
      { name: "limitPrice", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "IntentRejected",
    inputs: [
      { name: "intentId", type: "uint256", indexed: true },
      { name: "reason", type: "string", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "IntentNeedsApproval",
    inputs: [
      { name: "intentId", type: "uint256", indexed: true },
      { name: "amountCents", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ResultRecorded",
    inputs: [
      { name: "intentId", type: "uint256", indexed: true },
      { name: "filled", type: "bool", indexed: false },
      { name: "filledCents", type: "uint256", indexed: false },
      { name: "pnlCents", type: "int256", indexed: false },
    ],
    anonymous: false,
  },
  // ------------------------------------------------------------ errors
  { type: "error", name: "NotUser", inputs: [] },
  { type: "error", name: "NotAgent", inputs: [] },
  { type: "error", name: "NotExecutor", inputs: [] },
  { type: "error", name: "WrongStatus", inputs: [{ name: "current", type: "uint8" }] },
  { type: "error", name: "FillExceedsIntent", inputs: [] },
] as const;

/** Requested additions, each independent of the others. The production contract has all three since v2. */
export const policyExtensionsAbi = [
  // Request 1: details of every proposal in the log, so rejected intents keep them.
  {
    type: "event",
    name: "IntentProposed",
    inputs: [
      { name: "intentId", type: "uint256", indexed: true },
      { name: "agent", type: "address", indexed: true },
      { name: "market", type: "string", indexed: false },
      { name: "category", type: "uint8", indexed: false },
      { name: "outcome", type: "string", indexed: false },
      { name: "isBuy", type: "bool", indexed: false },
      { name: "amountCents", type: "uint256", indexed: false },
      { name: "limitPrice", type: "uint256", indexed: false },
      { name: "contextHash", type: "bytes32", indexed: false },
    ],
    anonymous: false,
  },
  // Request 2: a proposeTrade overload that records the decision context hash.
  {
    type: "function",
    name: "proposeTrade",
    inputs: [...proposeTradeInputs, { name: "contextHash", type: "bytes32" }],
    outputs: [{ name: "intentId", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  // Request 3: a dry run that uses the same rule function as proposeTrade.
  {
    type: "function",
    name: "previewTrade",
    inputs: [
      { name: "category", type: "uint8" },
      { name: "isBuy", type: "bool" },
      { name: "amountCents", type: "uint256" },
    ],
    outputs: [
      { name: "verdict", type: "uint8" },
      { name: "reason", type: "string" },
    ],
    stateMutability: "view",
  },
] as const;

const roleChanged = <name extends string>(name: name) =>
  ({
    type: "event",
    name,
    inputs: [
      { name: "previous", type: "address", indexed: true },
      { name: "current", type: "address", indexed: true },
    ],
    anonymous: false,
  }) as const;

/** What only the production contract (v2) has: a movable user role, role events, and zero-address checks. */
export const policyV2Abi = [
  {
    type: "function",
    name: "setUser",
    inputs: [{ name: "user_", type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  roleChanged("UserChanged"),
  roleChanged("AgentChanged"),
  roleChanged("ExecutorChanged"),
  { type: "error", name: "ZeroAddress", inputs: [] },
] as const;

/** The devchain reference contract: the base plus the extensions. */
export const policyReferenceAbi = [...policyBaseAbi, ...policyExtensionsAbi] as const;

/** The production contract's ABI, for encoding and for decoding anything either contract emits. */
export const policyAbi = [...policyBaseAbi, ...policyExtensionsAbi, ...policyV2Abi] as const;

export type PolicyBaseAbi = typeof policyBaseAbi;
export type PolicyAbi = typeof policyAbi;
