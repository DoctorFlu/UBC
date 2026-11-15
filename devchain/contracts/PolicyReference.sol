// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PolicyReference
/// @notice LOCAL REFERENCE ONLY, for development and tests. The production contract is
/// `contracts/src/Policy.sol`, owned by the contract team, and it is the source of truth.
///
/// This contract behaves exactly like `contracts/src/Policy.sol` for every function, event, error and
/// reason string that contract defines (the devchain tests run the same suite against both), and adds the
/// extensions requested in `docs/contract-interface.md`, marked "EXTENSION" below:
///   1. `IntentProposed`, emitted for every proposal before its verdict, so rejected intents keep their
///      details in the log.
///   2. A `proposeTrade` overload with a `bytes32 contextHash` (hash of the agent's decision context).
///   3. `previewTrade`, a dry run that uses the same rule function as `proposeTrade`.
/// Do not deploy it anywhere that holds real value.
contract PolicyReference {
    enum Status {
        None,
        Approved, // passed every rule, executor may place the order
        NeedsApproval, // above the user's approval threshold, waiting for the user
        Rejected, // broke a rule, or the user said no
        Executed, // executor placed the order and it filled (fully or partly)
        Failed // executor tried and nothing filled
    }

    struct PolicyRules {
        uint256 budgetCents; // rule 1: total the agent may deploy on buys
        uint256 maxTradeCents; // rule 2: largest single order
        uint256 allowedCategories; // rule 3: bitmask, bit N set = category N allowed
        uint256 approvalAboveCents; // rule 4: orders above this wait for the user (0 = never ask)
        uint256 dailyLossCents; // rule 5: stop trading once today's losses reach this (0 = off)
        bool paused; // rule 6: kill switch
    }

    struct Intent {
        string market;
        uint8 category;
        string outcome;
        bool isBuy;
        uint256 amountCents;
        uint256 limitPrice;
        Status status;
        uint64 proposedAt;
        uint256 filledCents;
        int256 pnlCents;
    }

    /// @dev EXTENSION: `previewTrade` verdicts.
    uint8 internal constant VERDICT_APPROVE = 0;
    uint8 internal constant VERDICT_NEEDS_APPROVAL = 1;
    uint8 internal constant VERDICT_REJECT = 2;

    address public immutable user;
    address public agent;
    address public executor;

    PolicyRules public policy;
    uint256 public committedCents;

    uint256 public lossDay;
    uint256 public dayLossCents;

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
    event IntentApproved(
        uint256 indexed intentId, string market, string outcome, bool isBuy, uint256 amountCents, uint256 limitPrice
    );
    event IntentRejected(uint256 indexed intentId, string reason);
    event IntentNeedsApproval(uint256 indexed intentId, uint256 amountCents);
    event ResultRecorded(uint256 indexed intentId, bool filled, uint256 filledCents, int256 pnlCents);

    /// @notice EXTENSION: every proposal, emitted before its verdict event.
    event IntentProposed(
        uint256 indexed intentId,
        address indexed agent,
        string market,
        uint8 category,
        string outcome,
        bool isBuy,
        uint256 amountCents,
        uint256 limitPrice,
        bytes32 contextHash
    );

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

    function approveIntent(uint256 intentId) external onlyUser {
        Intent storage it = intents[intentId];
        if (it.status != Status.NeedsApproval) revert WrongStatus(it.status);

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

    function proposeTrade(
        string calldata market,
        uint8 category,
        string calldata outcome,
        bool isBuy,
        uint256 amountCents,
        uint256 limitPrice
    ) external returns (uint256 intentId) {
        return _propose(market, category, outcome, isBuy, amountCents, limitPrice, bytes32(0));
    }

    /// @notice EXTENSION: the same as `proposeTrade`, plus the hash of the agent's decision context.
    function proposeTrade(
        string calldata market,
        uint8 category,
        string calldata outcome,
        bool isBuy,
        uint256 amountCents,
        uint256 limitPrice,
        bytes32 contextHash
    ) external returns (uint256 intentId) {
        return _propose(market, category, outcome, isBuy, amountCents, limitPrice, contextHash);
    }

    // ------------------------------------------------------------ executor

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
            // casting to uint256 is safe because pnlCents < 0 here, and negating int256.min reverts.
            // forge-lint: disable-next-line(unsafe-typecast)
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

    function lossTodayCents() public view returns (uint256) {
        // Day granularity makes validator timestamp drift of a few seconds irrelevant.
        // forge-lint: disable-next-line(block-timestamp)
        return block.timestamp / 1 days == lossDay ? dayLossCents : 0;
    }

    /// @notice EXTENSION: what `proposeTrade` would decide right now, without recording anything.
    /// @return verdict 0 approve, 1 needs approval, 2 reject.
    /// @return reason The rejection reason, empty unless the verdict is 2.
    function previewTrade(uint8 category, bool isBuy, uint256 amountCents)
        external
        view
        returns (uint8 verdict, string memory reason)
    {
        return _evaluate(category, isBuy, amountCents);
    }

    // ------------------------------------------------------------- internal

    function _propose(
        string calldata market,
        uint8 category,
        string calldata outcome,
        bool isBuy,
        uint256 amountCents,
        uint256 limitPrice,
        bytes32 contextHash
    ) internal returns (uint256 intentId) {
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
        emit IntentProposed(
            intentId, msg.sender, market, category, outcome, isBuy, amountCents, limitPrice, contextHash
        );
        _decide(intentId, intents[intentId]);
    }

    /// @dev Applies the verdict of `_evaluate` to a freshly proposed intent.
    function _decide(uint256 intentId, Intent storage it) internal {
        (uint8 verdict, string memory reason) = _evaluate(it.category, it.isBuy, it.amountCents);
        if (verdict == VERDICT_REJECT) {
            it.status = Status.Rejected;
            emit IntentRejected(intentId, reason);
        } else if (verdict == VERDICT_NEEDS_APPROVAL) {
            it.status = Status.NeedsApproval;
            emit IntentNeedsApproval(intentId, it.amountCents);
        } else {
            _approve(intentId, it);
        }
    }

    /// @dev The one rule function behind both `proposeTrade` and `previewTrade`.
    function _evaluate(uint8 category, bool isBuy, uint256 amountCents)
        internal
        view
        returns (uint8 verdict, string memory reason)
    {
        reason = _violation(category, isBuy, amountCents);
        if (bytes(reason).length != 0) return (VERDICT_REJECT, reason);
        if (policy.approvalAboveCents != 0 && amountCents > policy.approvalAboveCents) {
            return (VERDICT_NEEDS_APPROVAL, "");
        }
        return (VERDICT_APPROVE, "");
    }

    /// @dev Identical to `_violation` in contracts/src/Policy.sol, including rule order and reason strings.
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
