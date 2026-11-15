// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title PolicyReference
/// @notice LOCAL REFERENCE ONLY. This contract exists so offchain code (agent, console, executor) can run
/// end to end on a laptop before the production contract is ready. The production Policy contract lives
/// in `/contracts` and is owned by the contract team. This file implements the tech spec interface plus the
/// extensions requested in `docs/contract-interface.md`. Do not deploy it anywhere that holds real value.
///
/// Units: money is in integer cents. `limitPrice` is cents per one-dollar contract (1 to 99).
/// Categories are bit positions in `allowedCategories` (0 Crypto, 1 Sports, 2 Economics, 3 Commodities,
/// 4 Weather, 5 Politics, 6 Other).
///
/// Rule order in `_evaluate`: paused, category, max trade, budget, daily loss, then approval threshold.
/// A rule violation never reverts: the intent is stored as Rejected so blocked attempts stay in the log.
/// Only malformed input (zero amount, price out of range, unknown outcome, empty market) reverts.
contract PolicyReference {
    // ---------------------------------------------------------------- types

    struct Policy {
        uint256 budgetCents; // rule 1: total the agent may deploy
        uint256 maxTradeCents; // rule 2: largest single intent
        uint256 allowedCategories; // rule 3: bitmask of category ids
        uint256 approvalAboveCents; // rule 4: intents above this wait for the owner, 0 = never ask
        uint256 dailyLossCents; // rule 5: realized loss per UTC day that stops new intents, 0 = off
        bool paused; // rule 6: kill switch
    }

    enum Status {
        None,
        NeedsApproval,
        Approved,
        Rejected,
        Filled,
        Unfilled
    }

    struct Intent {
        address agent;
        string market;
        uint8 category;
        string outcome;
        bool isBuy;
        uint256 amountCents;
        uint256 limitPrice;
        bytes32 contextHash;
        Status status;
        string reason;
        uint64 proposedAt;
        uint256 filledCents;
        int256 pnlCents;
    }

    uint8 internal constant VERDICT_APPROVE = 0;
    uint8 internal constant VERDICT_NEEDS_APPROVAL = 1;
    uint8 internal constant VERDICT_REJECT = 2;

    string internal constant PAUSED = "PAUSED";
    string internal constant CATEGORY_NOT_ALLOWED = "CATEGORY_NOT_ALLOWED";
    string internal constant OVER_MAX_TRADE = "OVER_MAX_TRADE";
    string internal constant OVER_BUDGET = "OVER_BUDGET";
    string internal constant DAILY_LOSS_LIMIT = "DAILY_LOSS_LIMIT";
    string internal constant REJECTED_BY_OWNER = "REJECTED_BY_OWNER";

    // ---------------------------------------------------------------- errors

    error NotOwner();
    error NotAgent();
    error NotExecutor();
    error ZeroAddress();
    error InvalidAmount();
    error InvalidLimitPrice();
    error InvalidOutcome();
    error InvalidMarket();
    error IntentNotPending(uint256 intentId);
    error IntentNotApproved(uint256 intentId);
    error InvalidFill(uint256 intentId);

    // ---------------------------------------------------------------- events (spec)

    event IntentApproved(
        uint256 indexed intentId, string market, string outcome, bool isBuy, uint256 amountCents, uint256 limitPrice
    );
    event IntentRejected(uint256 indexed intentId, string reason);
    event IntentNeedsApproval(uint256 indexed intentId, uint256 amountCents);
    event ResultRecorded(uint256 indexed intentId, bool filled, uint256 filledCents, int256 pnlCents);

    // ---------------------------------------------------------------- events (requested extensions)

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
    event PolicySet(Policy policy);
    event PausedSet(bool paused);

    // ---------------------------------------------------------------- state

    address public owner;
    address public agent;
    address public executor;

    Policy internal _policy;
    mapping(uint256 intentId => Intent) internal _intents;
    uint256 public intentCount;

    /// @notice Cents committed by approved buy intents, corrected to the filled amount once a result lands.
    uint256 public spentCents;

    uint256 internal _lossDay;
    uint256 internal _lossDayCents;

    // ---------------------------------------------------------------- modifiers

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    modifier onlyExecutor() {
        if (msg.sender != executor) revert NotExecutor();
        _;
    }

    constructor(address agent_, address executor_) {
        if (agent_ == address(0) || executor_ == address(0)) revert ZeroAddress();
        owner = msg.sender;
        agent = agent_;
        executor = executor_;
    }

    // ---------------------------------------------------------------- owner

    function setPolicy(Policy calldata p) external onlyOwner {
        _policy = p;
        emit PolicySet(p);
    }

    function setPaused(bool paused) external onlyOwner {
        _policy.paused = paused;
        emit PausedSet(paused);
    }

    function setAgent(address newAgent) external onlyOwner {
        if (newAgent == address(0)) revert ZeroAddress();
        agent = newAgent;
    }

    function setExecutor(address newExecutor) external onlyOwner {
        if (newExecutor == address(0)) revert ZeroAddress();
        executor = newExecutor;
    }

    /// @notice Approves an intent that is waiting for the owner. The budget is checked again here because an
    /// intent waiting for approval reserves nothing; if it no longer fits it is rejected with OVER_BUDGET.
    function approveIntent(uint256 intentId) external onlyOwner {
        Intent storage intent = _intents[intentId];
        if (intent.status != Status.NeedsApproval) revert IntentNotPending(intentId);

        if (intent.isBuy && !_fitsBudget(intent.amountCents, _policy.budgetCents)) {
            _reject(intentId, intent, OVER_BUDGET);
            return;
        }
        _approve(intentId, intent);
    }

    function rejectIntent(uint256 intentId) external onlyOwner {
        Intent storage intent = _intents[intentId];
        if (intent.status != Status.NeedsApproval) revert IntentNotPending(intentId);
        _reject(intentId, intent, REJECTED_BY_OWNER);
    }

    // ---------------------------------------------------------------- agent

    function proposeTrade(
        string calldata market,
        uint8 category,
        string calldata outcome,
        bool isBuy,
        uint256 amountCents,
        uint256 limitPrice,
        bytes32 contextHash
    ) external onlyAgent returns (uint256 intentId) {
        if (bytes(market).length == 0) revert InvalidMarket();
        if (!_isOutcome(outcome)) revert InvalidOutcome();
        if (amountCents == 0) revert InvalidAmount();
        if (limitPrice == 0 || limitPrice > 99) revert InvalidLimitPrice();

        intentId = ++intentCount;
        Intent storage intent = _intents[intentId];
        intent.agent = msg.sender;
        intent.market = market;
        intent.category = category;
        intent.outcome = outcome;
        intent.isBuy = isBuy;
        intent.amountCents = amountCents;
        intent.limitPrice = limitPrice;
        intent.contextHash = contextHash;
        intent.proposedAt = uint64(block.timestamp);

        emit IntentProposed(
            intentId, msg.sender, market, category, outcome, isBuy, amountCents, limitPrice, contextHash
        );

        (uint8 verdict, string memory reason) = _evaluate(category, isBuy, amountCents);
        if (verdict == VERDICT_REJECT) {
            _reject(intentId, intent, reason);
        } else if (verdict == VERDICT_NEEDS_APPROVAL) {
            intent.status = Status.NeedsApproval;
            emit IntentNeedsApproval(intentId, amountCents);
        } else {
            _approve(intentId, intent);
        }
    }

    // ---------------------------------------------------------------- executor

    /// @notice Records the outcome of an approved intent. For a buy, the committed budget is corrected from
    /// the intent amount to the filled amount, which releases any unfilled remainder.
    function recordResult(uint256 intentId, bool filled, uint256 filledCents, int256 pnlCents) external onlyExecutor {
        Intent storage intent = _intents[intentId];
        if (intent.status != Status.Approved) revert IntentNotApproved(intentId);
        if (filledCents > intent.amountCents || (!filled && filledCents != 0)) revert InvalidFill(intentId);

        intent.status = filled ? Status.Filled : Status.Unfilled;
        intent.filledCents = filledCents;
        intent.pnlCents = pnlCents;

        if (intent.isBuy) {
            spentCents = spentCents - intent.amountCents + filledCents;
        }

        if (pnlCents < 0) {
            uint256 today = block.timestamp / 1 days;
            if (_lossDay != today) {
                _lossDay = today;
                _lossDayCents = 0;
            }
            // casting to uint256 is safe because pnlCents < 0 here, and negating int256.min reverts.
            // forge-lint: disable-next-line(unsafe-typecast)
            _lossDayCents += uint256(-pnlCents);
        }

        emit ResultRecorded(intentId, filled, filledCents, pnlCents);
    }

    // ---------------------------------------------------------------- views

    function policy() external view returns (Policy memory) {
        return _policy;
    }

    function getIntent(uint256 intentId) external view returns (Intent memory) {
        return _intents[intentId];
    }

    /// @notice Realized loss recorded in the current UTC day.
    function lossTodayCents() public view returns (uint256) {
        // Day granularity makes validator timestamp drift of a few seconds irrelevant.
        // forge-lint: disable-next-line(block-timestamp)
        return _lossDay == block.timestamp / 1 days ? _lossDayCents : 0;
    }

    /// @notice Dry run of `proposeTrade` against the current state, using the same rule function.
    function previewTrade(uint8 category, bool isBuy, uint256 amountCents)
        external
        view
        returns (uint8 verdict, string memory reason)
    {
        return _evaluate(category, isBuy, amountCents);
    }

    // ---------------------------------------------------------------- internals

    function _evaluate(uint8 category, bool isBuy, uint256 amountCents)
        internal
        view
        returns (uint8 verdict, string memory reason)
    {
        Policy memory p = _policy;
        if (p.paused) return (VERDICT_REJECT, PAUSED);
        if (p.allowedCategories & (uint256(1) << category) == 0) return (VERDICT_REJECT, CATEGORY_NOT_ALLOWED);
        if (amountCents > p.maxTradeCents) return (VERDICT_REJECT, OVER_MAX_TRADE);
        if (isBuy && !_fitsBudget(amountCents, p.budgetCents)) return (VERDICT_REJECT, OVER_BUDGET);
        if (p.dailyLossCents != 0 && lossTodayCents() >= p.dailyLossCents) return (VERDICT_REJECT, DAILY_LOSS_LIMIT);
        if (p.approvalAboveCents != 0 && amountCents > p.approvalAboveCents) return (VERDICT_NEEDS_APPROVAL, "");
        return (VERDICT_APPROVE, "");
    }

    /// @dev Written without `spentCents + amountCents` so that no input can overflow.
    function _fitsBudget(uint256 amountCents, uint256 budgetCents) internal view returns (bool) {
        return spentCents <= budgetCents && amountCents <= budgetCents - spentCents;
    }

    function _approve(uint256 intentId, Intent storage intent) internal {
        intent.status = Status.Approved;
        if (intent.isBuy) spentCents += intent.amountCents;
        emit IntentApproved(
            intentId, intent.market, intent.outcome, intent.isBuy, intent.amountCents, intent.limitPrice
        );
    }

    function _reject(uint256 intentId, Intent storage intent, string memory reason) internal {
        intent.status = Status.Rejected;
        intent.reason = reason;
        emit IntentRejected(intentId, reason);
    }

    function _isOutcome(string calldata outcome) internal pure returns (bool) {
        bytes32 h = keccak256(bytes(outcome));
        return h == keccak256("YES") || h == keccak256("NO");
    }
}
