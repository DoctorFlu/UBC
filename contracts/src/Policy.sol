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

    /// @dev Named PolicyRules because Solidity does not allow a struct called
    ///      Policy inside contract Policy. The fields match the spec's `Policy` struct.
    struct PolicyRules {
        uint256 budgetCents;        // rule 1: total the agent may deploy on buys
        uint256 maxTradeCents;      // rule 2: largest single order
        uint256 allowedCategories;  // rule 3: bitmask, bit N set = category N allowed
        uint256 approvalAboveCents; // rule 4: orders above this wait for the user (0 = never ask)
        uint256 dailyLossCents;     // rule 5: stop trading once today's losses reach this (0 = off)
        bool paused;                // rule 6: kill switch
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

    PolicyRules public policy;
    uint256 public committedCents; // budget already used by approved or executed buys

    // Rule 5 bookkeeping. Losses are summed per UTC day (block.timestamp / 1 days).
    uint256 public lossDay;      // the day dayLossCents refers to
    uint256 public dayLossCents; // losses recorded on lossDay

    Intent[] private intents;

    event PolicyUpdated(
        uint256 budgetCents,
        uint256 maxTradeCents,
        uint256 allowedCategories,
        uint256 approvalAboveCents,
        uint256 dailyLossCents,
        bool paused
    );
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

    /// @notice Replace every rule at once, including the pause flag.
    function setPolicy(PolicyRules calldata p) external onlyUser {
        policy = p;
        emit PolicyUpdated(
            p.budgetCents, p.maxTradeCents, p.allowedCategories, p.approvalAboveCents, p.dailyLossCents, p.paused
        );
        emit Paused(p.paused);
    }

    function setPaused(bool paused_) external onlyUser {
        policy.paused = paused_;
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
        if (it.isBuy && committedCents + it.amountCents > policy.budgetCents) {
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

        if (policy.approvalAboveCents != 0 && amountCents > policy.approvalAboveCents) {
            it.status = Status.NeedsApproval;
            emit IntentNeedsApproval(intentId, amountCents);
            return intentId;
        }

        _approve(intentId, it);
    }

    // ------------------------------------------------------------ executor

    /// @notice Record what happened to an approved intent. Unfilled budget is released
    ///         and a negative pnl counts toward today's loss (rule 5).
    function recordResult(uint256 intentId, bool filled, uint256 filledCents, int256 pnlCents) external {
        if (msg.sender != executor) revert NotExecutor();
        Intent storage it = intents[intentId];
        if (it.status != Status.Approved) revert WrongStatus(it.status);
        if (filledCents > it.amountCents) revert FillExceedsIntent();

        uint256 used = filled ? filledCents : 0;
        if (it.isBuy) committedCents -= (it.amountCents - used);

        if (pnlCents < 0) {
            uint256 today = block.timestamp / 1 days;
            if (today != lossDay) {
                lossDay = today;
                dayLossCents = 0;
            }
            dayLossCents += uint256(-pnlCents);
        }

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
        return policy.budgetCents > committedCents ? policy.budgetCents - committedCents : 0;
    }

    /// @notice Losses recorded so far today (UTC). Zero if the last loss was on an earlier day.
    function lossTodayCents() public view returns (uint256) {
        return block.timestamp / 1 days == lossDay ? dayLossCents : 0;
    }

    // ------------------------------------------------------------- internal

    function _violation(uint8 category, bool isBuy, uint256 amountCents) internal view returns (string memory) {
        if (policy.paused) return "agent paused";
        if (amountCents == 0) return "zero amount";
        if (policy.dailyLossCents != 0 && lossTodayCents() >= policy.dailyLossCents) return "daily loss limit reached";
        if (amountCents > policy.maxTradeCents) return "over max trade size";
        if (((policy.allowedCategories >> category) & 1) == 0) return "category not allowed";
        if (isBuy && committedCents + amountCents > policy.budgetCents) return "over budget";
        return "";
    }

    function _approve(uint256 intentId, Intent storage it) internal {
        if (it.isBuy) committedCents += it.amountCents;
        it.status = Status.Approved;
        emit IntentApproved(intentId, it.market, it.outcome, it.isBuy, it.amountCents, it.limitPrice);
    }
}
