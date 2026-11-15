import { readFileSync } from "node:fs";

/** Absolute path of the filter source that is uploaded to QuickNode. */
export const FILTER_PATH = new URL("../filter.js", import.meta.url);

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TOPIC = /^0x[0-9a-fA-F]{64}$/;

export interface FilterParameters {
  /** Policy contract address(es). At least one is required. */
  readonly addresses: readonly string[];
  /** topic0 values to keep. Empty keeps every event the contracts emit. */
  readonly topics?: readonly string[];
}

/** Reads streams/filter.js from disk. */
export function readFilterTemplate(): string {
  return readFileSync(FILTER_PATH, "utf8");
}

function replaceParameterLine(source: string, name: string, values: readonly string[]): string {
  const line = new RegExp(`^const ${name} = .*;$`, "m");
  const matches = source.match(new RegExp(line.source, "gm")) ?? [];
  if (matches.length !== 1) {
    throw new Error(`filter.js must declare ${name} on exactly one line, found ${matches.length}`);
  }
  return source.replace(line, () => `const ${name} = ${JSON.stringify(values)};`);
}

/**
 * Returns the filter source with the Policy address and topic parameters filled in.
 * Values are validated and lowercased so the filter can compare them as plain strings.
 */
export function renderFilter(template: string, parameters: FilterParameters): string {
  const addresses = parameters.addresses.map((address) => {
    if (!ADDRESS.test(address)) throw new Error(`Not a 20-byte hex address: ${address}`);
    return address.toLowerCase();
  });
  if (addresses.length === 0) throw new Error("At least one Policy contract address is required");
  const topics = (parameters.topics ?? []).map((topic) => {
    if (!TOPIC.test(topic)) throw new Error(`Not a 32-byte hex topic: ${topic}`);
    return topic.toLowerCase();
  });
  const withAddresses = replaceParameterLine(template, "POLICY_ADDRESSES", [...new Set(addresses)]);
  return replaceParameterLine(withAddresses, "TOPIC0_ALLOWLIST", [...new Set(topics)]);
}

/** Base64 of the UTF-8 source, the encoding the Streams REST API expects for `filter_function`. */
export function encodeFilter(source: string): string {
  return Buffer.from(source, "utf8").toString("base64");
}
