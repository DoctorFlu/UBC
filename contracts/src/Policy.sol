// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Policy
/// @notice On-chain rulebook and audit log for one user's trading agent.
///         The agent proposes trades, this contract approves or rejects them
///         against the user's rules, and the executor records what happened.
///         Funds never touch this contract: it authorises and records only.
contract Policy {
    enum Status {
        None,
        Approved,       // passed every rule, executor may place the order
        NeedsApproval,  // above the user's approval threshold, waiting for the user
        Rejected,       // broke a rule, or the user said no
        Executed,       // executor placed the order and it filled (fully or partly)
        Failed          // executor tried and nothing filled
    }

    struct Rules {
        uint256 budgetCents;        // rule 1: total the agent may deploy on buys
        uint256 maxTradeCents;      // rule 2: largest single order
        uint256 allowedCategories;  // rule 3: bitmask, bit N set = category N allowed
        uint256 approvalAboveCents; // rule 4: orders above this wait for the user (0 = never ask)
        bool paused;                // kill switch
    }

    struct Intent {
        string market;      // venue's market symbol
        uint8 category;
        string outcome;     // e.g. "YES"
        bool isBuy;
        uint256 amountCents;
        uint256 limitPrice; // venue's price units
        Status status;
        uint64 proposedAt;
        uint256 filledCents;
        int256 pnlCents;
    }

    address public immutable user;
    address public agent;
    address public executor;

    Rules public rules;
    uint256 public committedCents; // budget already used by approved or executed buys

    Intent[] private intents;

    event RulesUpdated(uint256 budgetCents, uint256 maxTradeCents, uint256 allowedCategories, uint256 approvalAboveCents);
    event Paused(bool paused);
    event IntentApproved(uint256 indexed intentId, string market, string outcome, bool isBuy, uint256 amountCents, uint256 limitPrice);
    event IntentRejected(uint256 indexed intentId, string reason);
    event IntentNeedsApproval(uint256 indexed intentId, uint256 amountCents);
    event ResultRecorded(uint256 indexed intentId, bool filled, uint256 filledCents, int256 pnlCents);

    error NotUser();
    error NotAgent();
    error NotExecutor();
    error WrongStatus(Status current);
    error FillExceedsIntent();

    modifier onlyUser() {
        if (msg.sender != user) revert NotUser();
        _;
    }

    constructor(address agent_, address executor_) {
        user = msg.sender;
        agent = agent_;
        executor = executor_;
    }

    // ---------------------------------------------------------------- user

    function setRules(
        uint256 budgetCents,
        uint256 maxTradeCents,
        uint256 allowedCategories,
        uint256 approvalAboveCents
    ) external onlyUser {
        rules.budgetCents = budgetCents;
        rules.maxTradeCents = maxTradeCents;
        rules.allowedCategories = allowedCategories;
        rules.approvalAboveCents = approvalAboveCents;
        emit RulesUpdated(budgetCents, maxTradeCents, allowedCategories, approvalAboveCents);
    }

    function setPaused(bool paused_) external onlyUser {
        rules.paused = paused_;
        emit Paused(paused_);
    }

    function setAgent(address agent_) external onlyUser {
        agent = agent_;
    }

    function setExecutor(address executor_) external onlyUser {
        executor = executor_;
    }

    /// @notice Approve an intent that was waiting on the user.
    function approveIntent(uint256 intentId) external onlyUser {
        Intent storage it = intents[intentId];
        if (it.status != Status.NeedsApproval) revert WrongStatus(it.status);

        // The budget may have been used up while this intent was waiting.
        if (it.isBuy && committedCents + it.amountCents > rules.budgetCents) {
            it.status = Status.Rejected;
            emit IntentRejected(intentId, "over budget");
            return;
        }
        _approve(intentId, it);
    }

    function rejectIntent(uint256 intentId) external onlyUser {
        Intent storage it = intents[intentId];
        if (it.status != Status.NeedsApproval) revert WrongStatus(it.status);
        it.status = Status.Rejected;
        emit IntentRejected(intentId, "rejected by user");
    }

    // --------------------------------------------------------------- agent

    /// @notice Propose a trade. Always records the intent and emits exactly one of
    ///         IntentApproved, IntentRejected or IntentNeedsApproval.
    function proposeTrade(
        string calldata market,
        uint8 category,
        string calldata outcome,
        bool isBuy,
        uint256 amountCents,
        uint256 limitPrice
    ) external returns (uint256 intentId) {
        if (msg.sender != agent) revert NotAgent();

        intentId = intents.length;
        intents.push(
            Intent({
                market: market,
                category: category,
                outcome: outcome,
                isBuy: isBuy,
                amountCents: amountCents,
                limitPrice: limitPrice,
                status: Status.None,
                proposedAt: uint64(block.timestamp),
                filledCents: 0,
                pnlCents: 0
            })
        );
        Intent storage it = intents[intentId];

        string memory reason = _violation(category, isBuy, amountCents);
        if (bytes(reason).length != 0) {
            it.status = Status.Rejected;
            emit IntentRejected(intentId, reason);
            return intentId;
        }

        if (rules.approvalAboveCents != 0 && amountCents > rules.approvalAboveCents) {
            it.status = Status.NeedsApproval;
            emit IntentNeedsApproval(intentId, amountCents);
            return intentId;
        }

        _approve(intentId, it);
    }

    // ------------------------------------------------------------ executor

    /// @notice Record what happened to an approved intent. Unfilled budget is released.
    function recordResult(uint256 intentId, bool filled, uint256 filledCents, int256 pnlCents) external {
        if (msg.sender != executor) revert NotExecutor();
        Intent storage it = intents[intentId];
        if (it.status != Status.Approved) revert WrongStatus(it.status);
        if (filledCents > it.amountCents) revert FillExceedsIntent();

        uint256 used = filled ? filledCents : 0;
        if (it.isBuy) committedCents -= (it.amountCents - used);

        it.status = filled ? Status.Executed : Status.Failed;
        it.filledCents = used;
        it.pnlCents = pnlCents;
        emit ResultRecorded(intentId, filled, used, pnlCents);
    }

    // ---------------------------------------------------------------- views

    function intentCount() external view returns (uint256) {
        return intents.length;
    }

    function getIntent(uint256 intentId) external view returns (Intent memory) {
        return intents[intentId];
    }

    function remainingBudgetCents() external view returns (uint256) {
        return rules.budgetCents > committedCents ? rules.budgetCents - committedCents : 0;
    }

    // ------------------------------------------------------------- internal

    function _violation(uint8 category, bool isBuy, uint256 amountCents) internal view returns (string memory) {
        if (rules.paused) return "agent paused";
        if (amountCents == 0) return "zero amount";
        if (amountCents > rules.maxTradeCents) return "over max trade size";
        if (((rules.allowedCategories >> category) & 1) == 0) return "category not allowed";
        if (isBuy && committedCents + amountCents > rules.budgetCents) return "over budget";
        return "";
    }

    function _approve(uint256 intentId, Intent storage it) internal {
        if (it.isBuy) committedCents += it.amountCents;
        it.status = Status.Approved;
        emit IntentApproved(intentId, it.market, it.outcome, it.isBuy, it.amountCents, it.limitPrice);
    }
}
