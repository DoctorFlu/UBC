import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  toHex,
  type AbiEvent,
  type Address,
  type ContractEventArgsFromTopics,
  type ContractEventName,
  type Hex,
  type Log,
} from "viem";
import { policyAbi, type PolicyAbi } from "../src";

export const POLICY_ADDRESS: Address = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

export interface LogPosition {
  blockNumber: number;
  logIndex: number;
  blockTimestamp?: number;
  transactionHash?: Hex;
  address?: Address;
}

/** Builds a log exactly as the contract would emit it, for decoding tests without a chain. */
export function makeLog<name extends ContractEventName<PolicyAbi>>(
  eventName: name,
  args: ContractEventArgsFromTopics<PolicyAbi, name>,
  position: LogPosition,
): Log {
  const event = policyAbi.find((item) => item.type === "event" && item.name === eventName) as AbiEvent;
  const topics = encodeEventTopics({ abi: [event], eventName: event.name, args: args as never });
  const values = args as Record<string, unknown>;
  const nonIndexed = event.inputs.filter((input) => !input.indexed);
  const data = encodeAbiParameters(
    nonIndexed,
    nonIndexed.map((input) => values[input.name ?? ""]),
  );
  return {
    address: position.address ?? POLICY_ADDRESS,
    blockHash: keccak256(toHex(`block-${position.blockNumber}`)),
    blockNumber: BigInt(position.blockNumber),
    blockTimestamp: position.blockTimestamp === undefined ? undefined : BigInt(position.blockTimestamp),
    data,
    logIndex: position.logIndex,
    removed: false,
    topics: topics as [Hex, ...Hex[]],
    transactionHash:
      position.transactionHash ?? keccak256(toHex(`tx-${position.blockNumber}-${position.logIndex}`)),
    transactionIndex: 0,
  };
}
