// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Policy} from "../src/Policy.sol";

contract PolicyTest is Test {
    Policy policy;
    address agent = address(0xA6E);
    address executor = address(0xE7EC);
    address stranger = address(0xBAD);

    uint8 constant SPORTS = 0;
    uint8 constant ECONOMICS = 1;
    uint8 constant POLITICS = 2;

    event IntentApproved(uint256 indexed intentId, string market, string outcome, bool isBuy, uint256 amountCents, uint256 limitPrice);
    event IntentRejected(uint256 indexed intentId, string reason);
    event IntentNeedsApproval(uint256 indexed intentId, uint256 amountCents);

    function setUp() public {
        policy = new Policy(agent, executor);
        // $200 budget, $100 max per trade, sports + economics allowed,
        // ask the user above $50, stop after $40 lost in a day.
        policy.setPolicy(_demoPolicy());
    }

    function _demoPolicy() internal pure returns (Policy.PolicyRules memory) {
        return Policy.PolicyRules({
            budgetCents: 20_000,
            maxTradeCents: 10_000,
            allowedCategories: (1 << SPORTS) | (1 << ECONOMICS),
            approvalAboveCents: 5_000,
            dailyLossCents: 4_000,
            paused: false
        });
    }

    function _propose(uint8 category, uint256 amount) internal returns (uint256) {
        vm.prank(agent);
        return policy.proposeTrade("MKT-TEST", category, "YES", true, amount, 55);
    }

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
        assertEq(categories, (1 << SPORTS) | (1 << ECONOMICS));
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

    function test_smallTradeIsApprovedAutomatically() public {
        vm.expectEmit(true, false, false, true);
        emit IntentApproved(0, "MKT-TEST", "YES", true, 2_000, 55);
        uint256 id = _propose(SPORTS, 2_000);
        assertEq(uint8(policy.getIntent(id).status), uint8(Policy.Status.Approved));
        assertEq(policy.committedCents(), 2_000);
    }

    function test_overMaxTradeIsRejected() public {
        vm.expectEmit(true, false, false, true);
        emit IntentRejected(0, "over max trade size");
        uint256 id = _propose(SPORTS, 10_001);
        assertEq(uint8(policy.getIntent(id).status), uint8(Policy.Status.Rejected));
        assertEq(policy.committedCents(), 0);
    }

    function test_disallowedCategoryIsRejected() public {
        vm.expectEmit(true, false, false, true);
        emit IntentRejected(0, "category not allowed");
        _propose(POLITICS, 1_000);
    }

    function test_overBudgetIsRejected() public {
        _propose(SPORTS, 5_000);
        _propose(SPORTS, 5_000);
        _propose(SPORTS, 5_000);
        _propose(SPORTS, 5_000); // budget now fully committed
        vm.expectEmit(true, false, false, true);
        emit IntentRejected(4, "over budget");
        _propose(SPORTS, 100);
    }

    function test_largeTradeWaitsThenUserApproves() public {
        vm.expectEmit(true, false, false, true);
        emit IntentNeedsApproval(0, 8_000);
        uint256 id = _propose(ECONOMICS, 8_000);
        assertEq(uint8(policy.getIntent(id).status), uint8(Policy.Status.NeedsApproval));
        assertEq(policy.committedCents(), 0);

        policy.approveIntent(id);
        assertEq(uint8(policy.getIntent(id).status), uint8(Policy.Status.Approved));
        assertEq(policy.committedCents(), 8_000);
    }

    function test_userCanRejectWaitingTrade() public {
        uint256 id = _propose(ECONOMICS, 8_000);
        policy.rejectIntent(id);
        assertEq(uint8(policy.getIntent(id).status), uint8(Policy.Status.Rejected));
    }

    function test_pausedAgentIsRejected() public {
        policy.setPaused(true);
        vm.expectEmit(true, false, false, true);
        emit IntentRejected(0, "agent paused");
        _propose(SPORTS, 1_000);
    }

    function test_dailyLossLimitBlocksTrading() public {
        uint256 id = _propose(SPORTS, 4_000);
        vm.prank(executor);
        policy.recordResult(id, true, 4_000, -4_000); // lost the whole $40 limit
        assertEq(policy.lossTodayCents(), 4_000);

        vm.expectEmit(true, false, false, true);
        emit IntentRejected(1, "daily loss limit reached");
        _propose(SPORTS, 1_000);
    }

    function test_dailyLossResetsNextDay() public {
        uint256 id = _propose(SPORTS, 4_000);
        vm.prank(executor);
        policy.recordResult(id, true, 4_000, -4_000);

        vm.warp(block.timestamp + 1 days);
        assertEq(policy.lossTodayCents(), 0);
        uint256 next = _propose(SPORTS, 1_000);
        assertEq(uint8(policy.getIntent(next).status), uint8(Policy.Status.Approved));
    }

    function test_dailyLossLimitOffWhenZero() public {
        Policy.PolicyRules memory p = _demoPolicy();
        p.dailyLossCents = 0;
        policy.setPolicy(p);

        uint256 id = _propose(SPORTS, 4_000);
        vm.prank(executor);
        policy.recordResult(id, true, 4_000, -9_000);
        uint256 next = _propose(SPORTS, 1_000);
        assertEq(uint8(policy.getIntent(next).status), uint8(Policy.Status.Approved));
    }

    function test_onlyAgentCanPropose() public {
        vm.prank(stranger);
        vm.expectRevert(Policy.NotAgent.selector);
        policy.proposeTrade("MKT-TEST", SPORTS, "YES", true, 1_000, 55);
    }

    function test_onlyUserCanApprove() public {
        uint256 id = _propose(ECONOMICS, 8_000);
        vm.prank(agent);
        vm.expectRevert(Policy.NotUser.selector);
        policy.approveIntent(id);
    }

    function test_resultReleasesUnfilledBudget() public {
        uint256 id = _propose(SPORTS, 4_000);
        vm.prank(executor);
        policy.recordResult(id, true, 1_500, 0);
        assertEq(uint8(policy.getIntent(id).status), uint8(Policy.Status.Executed));
        assertEq(policy.committedCents(), 1_500);
        assertEq(policy.remainingBudgetCents(), 18_500);
    }

    function test_failedOrderReleasesWholeAmount() public {
        uint256 id = _propose(SPORTS, 4_000);
        vm.prank(executor);
        policy.recordResult(id, false, 0, 0);
        assertEq(uint8(policy.getIntent(id).status), uint8(Policy.Status.Failed));
        assertEq(policy.committedCents(), 0);
    }

    function test_resultCannotBeRecordedTwice() public {
        uint256 id = _propose(SPORTS, 4_000);
        vm.startPrank(executor);
        policy.recordResult(id, true, 4_000, 0);
        vm.expectRevert(abi.encodeWithSelector(Policy.WrongStatus.selector, Policy.Status.Executed));
        policy.recordResult(id, true, 4_000, 0);
        vm.stopPrank();
    }

    function test_onlyExecutorCanRecord() public {
        uint256 id = _propose(SPORTS, 4_000);
        vm.prank(agent);
        vm.expectRevert(Policy.NotExecutor.selector);
        policy.recordResult(id, true, 4_000, 0);
    }
}
