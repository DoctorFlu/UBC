// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Policy} from "../src/Policy.sol";

contract PolicyTest is Test {
    Policy policy;
    address agent = address(0xA6E);
    address executor = address(0xE7EC);
    address stranger = address(0xBAD);

    // Agreed category numbers (contracts/README.md).
    uint8 constant CRYPTO = 0;
    uint8 constant SPORTS = 1;
    uint8 constant ECONOMICS = 2;
    uint8 constant POLITICS = 5;

    event UserChanged(address indexed previous, address indexed current);
    event AgentChanged(address indexed previous, address indexed current);
    event ExecutorChanged(address indexed previous, address indexed current);
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
    event IntentApproved(uint256 indexed intentId, string market, string outcome, bool isBuy, uint256 amountCents, uint256 limitPrice);
    event IntentRejected(uint256 indexed intentId, string reason);
    event IntentNeedsApproval(uint256 indexed intentId, uint256 amountCents);

    function setUp() public {
        policy = new Policy(agent, executor);
        // $200 budget, $100 max per trade, crypto + sports allowed,
        // ask the user above $50, stop after $40 lost in a day.
        policy.setPolicy(_demoPolicy());
    }

    function _demoPolicy() internal pure returns (Policy.PolicyRules memory) {
        return Policy.PolicyRules({
            budgetCents: 20_000,
            maxTradeCents: 10_000,
            allowedCategories: (1 << CRYPTO) | (1 << SPORTS),
            approvalAboveCents: 5_000,
            dailyLossCents: 4_000,
            paused: false
        });
    }

    function _propose(uint8 category, uint256 amount) internal returns (uint256) {
        vm.prank(agent);
        return policy.proposeTrade("MKT-TEST", category, "YES", true, amount, 55);
    }

    function _proposeRaw(string memory market, string memory outcome, uint256 limitPrice) internal returns (uint256) {
        vm.prank(agent);
        return policy.proposeTrade(market, CRYPTO, outcome, true, 1_000, limitPrice);
    }

    function _status(uint256 id) internal view returns (Policy.Status) {
        return policy.getIntent(id).status;
    }

    // ------------------------------------------------------------ policy

    function test_setPolicyStoresEveryField() public view {
        (
            uint256 budget,
            uint256 maxTrade,
            uint256 categories,
            uint256 approvalAbove,
            uint256 dailyLoss,
            bool paused
        ) = policy.policy();
        assertEq(budget, 20_000);
        assertEq(maxTrade, 10_000);
        assertEq(categories, (1 << CRYPTO) | (1 << SPORTS));
        assertEq(approvalAbove, 5_000);
        assertEq(dailyLoss, 4_000);
        assertFalse(paused);
    }

    function test_onlyUserCanSetPolicy() public {
        Policy.PolicyRules memory p = _demoPolicy();
        vm.prank(agent);
        vm.expectRevert(Policy.NotUser.selector);
        policy.setPolicy(p);
    }

    // ------------------------------------------------------------- rules

    function test_smallTradeIsApprovedAutomatically() public {
        vm.expectEmit(true, false, false, true);
        emit IntentApproved(0, "MKT-TEST", "YES", true, 2_000, 55);
        uint256 id = _propose(CRYPTO, 2_000);
        assertEq(uint8(_status(id)), uint8(Policy.Status.Approved));
        assertEq(policy.committedCents(), 2_000);
    }

    function test_overMaxTradeIsRejected() public {
        vm.expectEmit(true, false, false, true);
        emit IntentRejected(0, "over max trade size");
        uint256 id = _propose(CRYPTO, 10_001);
        assertEq(uint8(_status(id)), uint8(Policy.Status.Rejected));
        assertEq(policy.committedCents(), 0);
    }

    function test_disallowedCategoryIsRejected() public {
        vm.expectEmit(true, false, false, true);
        emit IntentRejected(0, "category not allowed");
        _propose(POLITICS, 1_000);
    }

    function test_overBudgetIsRejected() public {
        _propose(CRYPTO, 5_000);
        _propose(CRYPTO, 5_000);
        _propose(CRYPTO, 5_000);
        _propose(CRYPTO, 5_000); // budget now fully committed
        vm.expectEmit(true, false, false, true);
        emit IntentRejected(4, "over budget");
        _propose(CRYPTO, 100);
    }

    function test_largeTradeWaitsThenUserApproves() public {
        vm.expectEmit(true, false, false, true);
        emit IntentNeedsApproval(0, 8_000);
        uint256 id = _propose(SPORTS, 8_000);
        assertEq(uint8(_status(id)), uint8(Policy.Status.NeedsApproval));
        assertEq(policy.committedCents(), 0);

        policy.approveIntent(id);
        assertEq(uint8(_status(id)), uint8(Policy.Status.Approved));
        assertEq(policy.committedCents(), 8_000);
    }

    function test_userCanRejectWaitingTrade() public {
        uint256 id = _propose(SPORTS, 8_000);
        policy.rejectIntent(id);
        assertEq(uint8(_status(id)), uint8(Policy.Status.Rejected));
    }

    function test_pausedAgentIsRejected() public {
        policy.setPaused(true);
        vm.expectEmit(true, false, false, true);
        emit IntentRejected(0, "agent paused");
        _propose(CRYPTO, 1_000);
    }

    function test_dailyLossLimitBlocksTrading() public {
        uint256 id = _propose(CRYPTO, 4_000);
        vm.prank(executor);
        policy.recordResult(id, true, 4_000, -4_000); // lost the whole $40 limit
        assertEq(policy.lossTodayCents(), 4_000);

        vm.expectEmit(true, false, false, true);
        emit IntentRejected(1, "daily loss limit reached");
        _propose(CRYPTO, 1_000);
    }

    function test_dailyLossResetsNextDay() public {
        uint256 id = _propose(CRYPTO, 4_000);
        vm.prank(executor);
        policy.recordResult(id, true, 4_000, -4_000);

        vm.warp(block.timestamp + 1 days);
        assertEq(policy.lossTodayCents(), 0);
        uint256 next = _propose(CRYPTO, 1_000);
        assertEq(uint8(_status(next)), uint8(Policy.Status.Approved));
    }

    function test_dailyLossLimitOffWhenZero() public {
        Policy.PolicyRules memory p = _demoPolicy();
        p.dailyLossCents = 0;
        policy.setPolicy(p);

        uint256 id = _propose(CRYPTO, 4_000);
        vm.prank(executor);
        policy.recordResult(id, true, 4_000, -9_000);
        uint256 next = _propose(CRYPTO, 1_000);
        assertEq(uint8(_status(next)), uint8(Policy.Status.Approved));
    }

    // ------------------------------------------- approveIntent re-checks every rule

    function test_approveIntentRejectsWhenPaused() public {
        uint256 id = _propose(SPORTS, 8_000);
        policy.setPaused(true);
        vm.expectEmit(true, false, false, true);
        emit IntentRejected(id, "agent paused");
        policy.approveIntent(id);
        assertEq(uint8(_status(id)), uint8(Policy.Status.Rejected));
        assertEq(policy.committedCents(), 0);
    }

    function test_approveIntentRejectsWhenCategoryRemoved() public {
        uint256 id = _propose(SPORTS, 8_000);
        Policy.PolicyRules memory p = _demoPolicy();
        p.allowedCategories = 1 << CRYPTO;
        policy.setPolicy(p);
        vm.expectEmit(true, false, false, true);
        emit IntentRejected(id, "category not allowed");
        policy.approveIntent(id);
    }

    function test_approveIntentRejectsWhenBudgetGone() public {
        uint256 held = _propose(CRYPTO, 8_000);
        _propose(CRYPTO, 5_000);
        _propose(CRYPTO, 5_000);
        _propose(CRYPTO, 5_000); // 15_000 committed, 5_000 left
        vm.expectEmit(true, false, false, true);
        emit IntentRejected(held, "over budget");
        policy.approveIntent(held);
    }

    // ----------------------------------------------------- format validation

    function test_limitPriceMustBe1To99() public {
        vm.expectEmit(true, false, false, true);
        emit IntentRejected(0, "invalid limit price");
        _proposeRaw("MKT-TEST", "YES", 0);
        vm.expectEmit(true, false, false, true);
        emit IntentRejected(1, "invalid limit price");
        _proposeRaw("MKT-TEST", "YES", 100);
        uint256 ok1 = _proposeRaw("MKT-TEST", "YES", 1);
        uint256 ok99 = _proposeRaw("MKT-TEST", "NO", 99);
        assertEq(uint8(_status(ok1)), uint8(Policy.Status.Approved));
        assertEq(uint8(_status(ok99)), uint8(Policy.Status.Approved));
    }

    function test_outcomeMustBeYesOrNo() public {
        vm.expectEmit(true, false, false, true);
        emit IntentRejected(0, "invalid outcome");
        _proposeRaw("MKT-TEST", "MAYBE", 55);
        vm.expectEmit(true, false, false, true);
        emit IntentRejected(1, "invalid outcome");
        _proposeRaw("MKT-TEST", "yes", 55);
    }

    function test_marketMustBe1To128Bytes() public {
        vm.expectEmit(true, false, false, true);
        emit IntentRejected(0, "invalid market");
        _proposeRaw("", "YES", 55);

        bytes memory long = new bytes(129);
        for (uint256 i = 0; i < 129; i++) long[i] = "M";
        vm.expectEmit(true, false, false, true);
        emit IntentRejected(1, "invalid market");
        _proposeRaw(string(long), "YES", 55);

        bytes memory max = new bytes(128);
        for (uint256 i = 0; i < 128; i++) max[i] = "M";
        uint256 ok = _proposeRaw(string(max), "YES", 55);
        assertEq(uint8(_status(ok)), uint8(Policy.Status.Approved));
    }

    function test_malformedIntentIsStillRecorded() public {
        uint256 id = _proposeRaw("MKT-TEST", "MAYBE", 55);
        assertEq(policy.intentCount(), 1);
        assertEq(uint8(_status(id)), uint8(Policy.Status.Rejected));
        assertEq(policy.committedCents(), 0);
    }

    // ------------------------------------------- IntentProposed and contextHash

    function test_proposeEmitsIntentProposedWithZeroHash() public {
        vm.expectEmit(true, true, false, true);
        emit IntentProposed(0, agent, "MKT-TEST", CRYPTO, "YES", true, 2_000, 55, bytes32(0));
        _propose(CRYPTO, 2_000);
    }

    function test_proposeWithContextHashEmitsIt() public {
        bytes32 ctx = keccak256("the agent's reasons");
        vm.expectEmit(true, true, false, true);
        emit IntentProposed(0, agent, "MKT-TEST", CRYPTO, "YES", true, 2_000, 55, ctx);
        vm.prank(agent);
        uint256 id = policy.proposeTrade("MKT-TEST", CRYPTO, "YES", true, 2_000, 55, ctx);
        assertEq(uint8(_status(id)), uint8(Policy.Status.Approved));
    }

    function test_intentProposedComesBeforeVerdict() public {
        vm.expectEmit(true, true, false, true);
        emit IntentProposed(0, agent, "MKT-TEST", POLITICS, "YES", true, 1_000, 55, bytes32(0));
        vm.expectEmit(true, false, false, true);
        emit IntentRejected(0, "category not allowed");
        _propose(POLITICS, 1_000);
    }

    // ------------------------------------------------------------ previewTrade

    function test_previewMatchesPropose() public {
        (uint8 v, string memory r) = policy.previewTrade(CRYPTO, true, 2_000);
        assertEq(v, 0);
        assertEq(r, "");

        (v, r) = policy.previewTrade(CRYPTO, true, 8_000);
        assertEq(v, 1);

        (v, r) = policy.previewTrade(POLITICS, true, 1_000);
        assertEq(v, 2);
        assertEq(r, "category not allowed");

        assertEq(policy.intentCount(), 0); // nothing recorded
    }

    // ------------------------------------------------------------------ roles

    function test_onlyAgentCanPropose() public {
        vm.prank(stranger);
        vm.expectRevert(Policy.NotAgent.selector);
        policy.proposeTrade("MKT-TEST", CRYPTO, "YES", true, 1_000, 55);
    }

    function test_onlyUserCanApprove() public {
        uint256 id = _propose(SPORTS, 8_000);
        vm.prank(agent);
        vm.expectRevert(Policy.NotUser.selector);
        policy.approveIntent(id);
    }

    function test_setUserHandsOverTheRole() public {
        address newUser = address(0x0123);
        vm.expectEmit(true, true, false, false);
        emit UserChanged(address(this), newUser);
        policy.setUser(newUser);
        assertEq(policy.user(), newUser);

        vm.expectRevert(Policy.NotUser.selector);
        policy.setPaused(true); // the deployer lost the role

        vm.prank(newUser);
        policy.setPaused(true);
    }

    function test_roleSettersRejectZeroAddress() public {
        vm.expectRevert(Policy.ZeroAddress.selector);
        policy.setUser(address(0));
        vm.expectRevert(Policy.ZeroAddress.selector);
        policy.setAgent(address(0));
        vm.expectRevert(Policy.ZeroAddress.selector);
        policy.setExecutor(address(0));
    }

    function test_roleSettersEmitEvents() public {
        vm.expectEmit(true, true, false, false);
        emit AgentChanged(agent, address(0xA6E2));
        policy.setAgent(address(0xA6E2));
        vm.expectEmit(true, true, false, false);
        emit ExecutorChanged(executor, address(0xE7EC2));
        policy.setExecutor(address(0xE7EC2));
    }

    function test_constructorRejectsZeroAddress() public {
        vm.expectRevert(Policy.ZeroAddress.selector);
        new Policy(address(0), executor);
    }

    // --------------------------------------------------------------- results

    function test_resultReleasesUnfilledBudget() public {
        uint256 id = _propose(CRYPTO, 4_000);
        vm.prank(executor);
        policy.recordResult(id, true, 1_500, 0);
        assertEq(uint8(_status(id)), uint8(Policy.Status.Executed));
        assertEq(policy.committedCents(), 1_500);
        assertEq(policy.remainingBudgetCents(), 18_500);
    }

    function test_failedOrderReleasesWholeAmount() public {
        uint256 id = _propose(CRYPTO, 4_000);
        vm.prank(executor);
        policy.recordResult(id, false, 0, 0);
        assertEq(uint8(_status(id)), uint8(Policy.Status.Failed));
        assertEq(policy.committedCents(), 0);
    }

    function test_resultCannotBeRecordedTwice() public {
        uint256 id = _propose(CRYPTO, 4_000);
        vm.startPrank(executor);
        policy.recordResult(id, true, 4_000, 0);
        vm.expectRevert(abi.encodeWithSelector(Policy.WrongStatus.selector, Policy.Status.Executed));
        policy.recordResult(id, true, 4_000, 0);
        vm.stopPrank();
    }

    function test_onlyExecutorCanRecord() public {
        uint256 id = _propose(CRYPTO, 4_000);
        vm.prank(agent);
        vm.expectRevert(Policy.NotExecutor.selector);
        policy.recordResult(id, true, 4_000, 0);
    }
}
