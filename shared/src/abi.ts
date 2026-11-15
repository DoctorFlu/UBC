/**
 * ABI of the Policy contract: the tech spec interface plus the extensions requested in
 * `docs/contract-interface.md`. This is the only ABI offchain code should import.
 *
 * `internalType` is left out on purpose so the ABI does not depend on the contract's Solidity names.
 * The devchain test suite checks that the reference contract compiles to exactly this ABI.
 */

const policyComponents = [
  { name: "budgetCents", type: "uint256" },
  { name: "maxTradeCents", type: "uint256" },
  { name: "allowedCategories", type: "uint256" },
  { name: "approvalAboveCents", type: "uint256" },
  { name: "dailyLossCents", type: "uint256" },
  { name: "paused", type: "bool" },
] as const;

const intentComponents = [
  { name: "agent", type: "address" },
  { name: "market", type: "string" },
  { name: "category", type: "uint8" },
  { name: "outcome", type: "string" },
  { name: "isBuy", type: "bool" },
  { name: "amountCents", type: "uint256" },
  { name: "limitPrice", type: "uint256" },
  { name: "contextHash", type: "bytes32" },
  { name: "status", type: "uint8" },
  { name: "reason", type: "string" },
  { name: "proposedAt", type: "uint64" },
  { name: "filledCents", type: "uint256" },
  { name: "pnlCents", type: "int256" },
] as const;

export const policyAbi = [
  // ------------------------------------------------------------ spec: owner
  {
    type: "function",
    name: "setPolicy",
    inputs: [{ name: "p", type: "tuple", components: policyComponents }],
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
  {
    type: "function",
    name: "setPaused",
    inputs: [{ name: "paused", type: "bool" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // ------------------------------------------------------------ spec: agent (plus extension 1: contextHash)
  {
    type: "function",
    name: "proposeTrade",
    inputs: [
      { name: "market", type: "string" },
      { name: "category", type: "uint8" },
      { name: "outcome", type: "string" },
      { name: "isBuy", type: "bool" },
      { name: "amountCents", type: "uint256" },
      { name: "limitPrice", type: "uint256" },
      { name: "contextHash", type: "bytes32" },
    ],
    outputs: [{ name: "intentId", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  // ------------------------------------------------------------ spec: executor
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
  // ------------------------------------------------------------ spec: events
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
  // ------------------------------------------------------------ extension 2 and 3: events
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
  {
    type: "event",
    name: "PolicySet",
    inputs: [{ name: "policy", type: "tuple", indexed: false, components: policyComponents }],
    anonymous: false,
  },
  {
    type: "event",
    name: "PausedSet",
    inputs: [{ name: "paused", type: "bool", indexed: false }],
    anonymous: false,
  },
  // ------------------------------------------------------------ extension 4 and 5: views
  {
    type: "function",
    name: "policy",
    inputs: [],
    outputs: [{ name: "", type: "tuple", components: policyComponents }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "owner",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "agent",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "executor",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "spentCents",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "lossTodayCents",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "intentCount",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getIntent",
    inputs: [{ name: "intentId", type: "uint256" }],
    outputs: [{ name: "", type: "tuple", components: intentComponents }],
    stateMutability: "view",
  },
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
  // ------------------------------------------------------------ open question: role management
  {
    type: "function",
    name: "setAgent",
    inputs: [{ name: "newAgent", type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setExecutor",
    inputs: [{ name: "newExecutor", type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // ------------------------------------------------------------ errors (requested names, so clients can explain reverts)
  { type: "error", name: "NotOwner", inputs: [] },
  { type: "error", name: "NotAgent", inputs: [] },
  { type: "error", name: "NotExecutor", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
  { type: "error", name: "InvalidAmount", inputs: [] },
  { type: "error", name: "InvalidLimitPrice", inputs: [] },
  { type: "error", name: "InvalidOutcome", inputs: [] },
  { type: "error", name: "InvalidMarket", inputs: [] },
  { type: "error", name: "IntentNotPending", inputs: [{ name: "intentId", type: "uint256" }] },
  { type: "error", name: "IntentNotApproved", inputs: [{ name: "intentId", type: "uint256" }] },
  { type: "error", name: "InvalidFill", inputs: [{ name: "intentId", type: "uint256" }] },
] as const;

export type PolicyAbi = typeof policyAbi;
