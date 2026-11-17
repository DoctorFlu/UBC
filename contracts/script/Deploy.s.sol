// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Policy} from "../src/Policy.sol";

/// Deploys Policy, sets the demo rules and, if OWNER is set, hands the user role to it.
///
/// Usage:
///   AGENT=0x... EXECUTOR=0x... [OWNER=0x...] forge script script/Deploy.s.sol \
///     --rpc-url $RPC_URL --private-key $DEPLOYER_PRIVATE_KEY --broadcast
///
/// The deployer pays gas and is the user until OWNER takes over in the same run.
contract Deploy is Script {
    function run() external {
        address agent = vm.envAddress("AGENT");
        address executor = vm.envAddress("EXECUTOR");
        address owner = vm.envOr("OWNER", address(0));

        vm.startBroadcast();
        Policy policy = new Policy(agent, executor);
        // Demo rules, the same as DEMO_POLICY in devchain/src/deploy.ts:
        // $200 budget, $25 max per trade, Crypto only (bit 0), ask above $20,
        // stop after $40 lost in a day, not paused.
        policy.setPolicy(
            Policy.PolicyRules({
                budgetCents: 20_000,
                maxTradeCents: 2_500,
                allowedCategories: 1,
                approvalAboveCents: 2_000,
                dailyLossCents: 4_000,
                paused: false
            })
        );
        if (owner != address(0)) policy.setUser(owner);
        vm.stopBroadcast();

        console.log("Policy deployed at", address(policy));
        console.log("Deploy block", block.number);
        console.log("User", policy.user());
    }
}
