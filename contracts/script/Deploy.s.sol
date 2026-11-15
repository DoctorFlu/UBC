// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Policy} from "../src/Policy.sol";

/// Usage:
///   AGENT=0x... EXECUTOR=0x... forge script script/Deploy.s.sol \
///     --rpc-url $RPC_URL --private-key $USER_PRIVATE_KEY --broadcast
contract Deploy is Script {
    function run() external {
        address agent = vm.envAddress("AGENT");
        address executor = vm.envAddress("EXECUTOR");

        vm.startBroadcast();
        Policy policy = new Policy(agent, executor);
        // Demo rules: $200 budget, $100 max per trade, categories 0 and 1,
        // ask above $50, stop after $40 lost in a day, not paused.
        policy.setPolicy(
            Policy.PolicyRules({
                budgetCents: 20_000,
                maxTradeCents: 10_000,
                allowedCategories: 3,
                approvalAboveCents: 5_000,
                dailyLossCents: 4_000,
                paused: false
            })
        );
        vm.stopBroadcast();

        console.log("Policy deployed at", address(policy));
    }
}
