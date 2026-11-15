/**
 * Deterministic plan id: 64-bit FNV-1a over a canonical string. The same inputs and orders
 * always give the same id, in Node and in the browser. It names a plan; it is not a security
 * hash (sealed decision context uses its own hash).
 */
const OFFSET = 0xcbf29ce484222325n;
const PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

export function planIdFor(canonical: string): string {
  let hash = OFFSET;
  for (const byte of new TextEncoder().encode(canonical)) {
    hash ^= BigInt(byte);
    hash = (hash * PRIME) & MASK;
  }
  return `plan_${hash.toString(16).padStart(16, "0")}`;
}
