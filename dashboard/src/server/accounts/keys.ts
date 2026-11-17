import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";

import { type AgentSigner } from "@mandate/shared";
import type { Address, Hex, TransactionSerializable } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

/**
 * The console's key store for agent keys: envelope encryption under one master key (docs/accounts.md).
 *
 * Each agent key is encrypted with its own random 256-bit data key (AES-256-GCM), and the data key with the
 * master key (AES-256-GCM). Both bind the agent id as additional authenticated data, so a sealed key cannot
 * be moved to another agent's row. The master key never touches the database.
 */

const KEY_BYTES = 32;

/** The master key. It renders as `[redacted]` in strings, JSON and `util.inspect`, so it cannot be logged. */
export class MasterKey {
  readonly #key: Buffer;
  /** A public fingerprint (8 hex digits of its SHA-256), so a sealed key names the master key it needs. */
  readonly id: string;

  constructor(key: Buffer) {
    if (key.length !== KEY_BYTES) throw new Error("the master key must be 32 bytes");
    this.#key = Buffer.from(key);
    this.id = createHash("sha256").update(this.#key).digest("hex").slice(0, 8);
  }

  /** For `sealAgentKey` and `openAgentKey` only. */
  bytes(): Buffer {
    return this.#key;
  }

  toString(): string {
    return "[redacted]";
  }

  toJSON(): string {
    return "[redacted]";
  }

  [inspect.custom](): string {
    return "MasterKey [redacted]";
  }
}

/** Reads a master key written as 64 hex digits, or base64 or base64url of 32 bytes. Null when it is none. */
export function parseMasterKey(text: string): MasterKey | null {
  const value = text.trim();
  let bytes: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(value)) bytes = Buffer.from(value, "hex");
  else if (/^[A-Za-z0-9+/_-]{43,44}={0,2}$/.test(value)) {
    bytes = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  }
  return bytes?.length === KEY_BYTES ? new MasterKey(bytes) : null;
}

export class MasterKeyError extends Error {
  override readonly name = "MasterKeyError";
}

export interface MasterKeySettings {
  mode: "production" | "development";
  /** `CONSOLE_MASTER_KEY_FILE`, or null. */
  file: string | null;
  /** `CONSOLE_MASTER_KEY`, or null. */
  value: string | null;
  /** The console's data directory, where development keeps a generated key. */
  dataDir: string;
}

export const DEV_MASTER_KEY_FILE = "master.key";

/**
 * The master key from the settings: the file, else the variable. In production one of them is required. In
 * development, without either, a key is generated once in the data directory (mode 600) and reused; the log
 * line names the file, never the key. Errors name the setting, never its value.
 */
export function loadMasterKey(settings: MasterKeySettings, log: (message: string) => void): MasterKey {
  if (settings.file !== null && settings.value !== null) {
    throw new MasterKeyError("Set CONSOLE_MASTER_KEY_FILE or CONSOLE_MASTER_KEY, not both.");
  }
  if (settings.file !== null) {
    let text: string;
    try {
      text = readFileSync(settings.file, "utf8");
    } catch {
      throw new MasterKeyError(`CONSOLE_MASTER_KEY_FILE: cannot read ${settings.file}.`);
    }
    const key = parseMasterKey(text);
    if (!key) {
      throw new MasterKeyError(
        `CONSOLE_MASTER_KEY_FILE: ${settings.file} does not hold a 32-byte key (64 hex digits or base64).`,
      );
    }
    return key;
  }
  if (settings.value !== null) {
    const key = parseMasterKey(settings.value);
    if (!key) {
      throw new MasterKeyError("CONSOLE_MASTER_KEY: is not a 32-byte key (64 hex digits or base64).");
    }
    return key;
  }
  if (settings.mode === "production") {
    throw new MasterKeyError(
      "The console needs a master key in production: set CONSOLE_MASTER_KEY_FILE (a file holding 32 random " +
        "bytes as base64, such as a Docker secret) or CONSOLE_MASTER_KEY. See docs/accounts.md.",
    );
  }
  const path = join(settings.dataDir, DEV_MASTER_KEY_FILE);
  if (existsSync(path)) {
    const key = parseMasterKey(readFileSync(path, "utf8"));
    if (!key) throw new MasterKeyError(`The development master key in ${path} is not a 32-byte key.`);
    return key;
  }
  writeFileSync(path, `${randomBytes(KEY_BYTES).toString("base64url")}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  log(
    `created a development master key in ${path} (mode 600). Production needs CONSOLE_MASTER_KEY_FILE or ` +
      "CONSOLE_MASTER_KEY instead.",
  );
  const key = parseMasterKey(readFileSync(path, "utf8"));
  if (!key) throw new MasterKeyError(`The development master key in ${path} is not a 32-byte key.`);
  return key;
}

// ------------------------------------------------------------------ envelope encryption

const box = z.strictObject({ iv: z.string(), data: z.string(), tag: z.string() });
const sealedSchema = z.strictObject({
  v: z.literal(1),
  /** The master key's fingerprint. */
  kek: z.string(),
  /** The data key, encrypted with the master key. */
  dek: box,
  /** The agent key, encrypted with the data key. */
  key: box,
});

function seal(key: Buffer, plaintext: Buffer, aad: string): z.infer<typeof box> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    data: data.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function open(key: Buffer, sealed: z.infer<typeof box>, aad: string): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]);
}

/** Encrypts an agent's private key for the store. The result is JSON with no secret in the clear. */
export function sealAgentKey(master: MasterKey, agentId: string, privateKey: Hex): string {
  const dataKey = randomBytes(KEY_BYTES);
  try {
    const sealed: z.infer<typeof sealedSchema> = {
      v: 1,
      kek: master.id,
      dek: seal(master.bytes(), dataKey, `mandate.agent-dek.v1:${agentId}`),
      key: seal(dataKey, Buffer.from(privateKey.slice(2), "hex"), `mandate.agent-key.v1:${agentId}`),
    };
    return JSON.stringify(sealed);
  } finally {
    dataKey.fill(0);
  }
}

/** Decrypts a sealed agent key. Throws, without detail, when the master key or the agent id is wrong. */
export function openAgentKey(master: MasterKey, agentId: string, sealedText: string): Hex {
  const sealed = sealedSchema.parse(JSON.parse(sealedText));
  if (sealed.kek !== master.id) {
    throw new MasterKeyError(
      `This agent key was sealed with master key ${sealed.kek}, but the console has ${master.id}.`,
    );
  }
  let dataKey: Buffer | null = null;
  try {
    dataKey = open(master.bytes(), sealed.dek, `mandate.agent-dek.v1:${agentId}`);
    const key = open(dataKey, sealed.key, `mandate.agent-key.v1:${agentId}`);
    const hex: Hex = `0x${key.toString("hex")}`;
    key.fill(0);
    return hex;
  } catch (error) {
    if (error instanceof MasterKeyError) throw error;
    throw new MasterKeyError("The agent key could not be decrypted.");
  } finally {
    dataKey?.fill(0);
  }
}

/**
 * Owner keys (#95): the key a `server` mandate's Policy contract names as its `user()`, which only the
 * console holds on the demo chain. Sealed like an agent key, but bound to the mandate under other labels,
 * so neither kind of sealed key opens as the other.
 */
export function sealOwnerKey(master: MasterKey, mandateId: string, privateKey: Hex): string {
  const dataKey = randomBytes(KEY_BYTES);
  try {
    const sealed: z.infer<typeof sealedSchema> = {
      v: 1,
      kek: master.id,
      dek: seal(master.bytes(), dataKey, `mandate.owner-dek.v1:${mandateId}`),
      key: seal(dataKey, Buffer.from(privateKey.slice(2), "hex"), `mandate.owner-key.v1:${mandateId}`),
    };
    return JSON.stringify(sealed);
  } finally {
    dataKey.fill(0);
  }
}

/** Decrypts a sealed owner key. Throws, without detail, when the master key or the mandate id is wrong. */
export function openOwnerKey(master: MasterKey, mandateId: string, sealedText: string): Hex {
  const sealed = sealedSchema.parse(JSON.parse(sealedText));
  if (sealed.kek !== master.id) {
    throw new MasterKeyError(
      `This owner key was sealed with master key ${sealed.kek}, but the console has ${master.id}.`,
    );
  }
  let dataKey: Buffer | null = null;
  try {
    dataKey = open(master.bytes(), sealed.dek, `mandate.owner-dek.v1:${mandateId}`);
    const key = open(dataKey, sealed.key, `mandate.owner-key.v1:${mandateId}`);
    const hex: Hex = `0x${key.toString("hex")}`;
    key.fill(0);
    return hex;
  } catch (error) {
    if (error instanceof MasterKeyError) throw error;
    throw new MasterKeyError("The owner key could not be decrypted.");
  } finally {
    dataKey?.fill(0);
  }
}

/** A new owner key, sealed, with its public address. */
export function createSealedOwnerKey(
  master: MasterKey,
  mandateId: string,
): { address: Address; sealed: string } {
  const key = generatePrivateKey();
  return { address: privateKeyToAccount(key).address, sealed: sealOwnerKey(master, mandateId, key) };
}

/**
 * The account of a mandate's owner key, for one signature or one transaction, checked against the address
 * stored with it. Callers decide what may be signed (the owner call route and the server deployer).
 */
export function ownerAccount(
  master: MasterKey,
  mandateId: string,
  key: { address: Address; sealed: string },
) {
  const account = privateKeyToAccount(openOwnerKey(master, mandateId, key.sealed));
  if (account.address !== key.address) {
    throw new MasterKeyError("The decrypted key does not belong to this mandate's owner.");
  }
  return account;
}

/** A new agent key, sealed, with its public address. The key itself is gone when this returns. */
export function createSealedAgentKey(
  master: MasterKey,
  agentId: string,
): { address: Address; sealed: string } {
  const key = generatePrivateKey();
  return { address: privateKeyToAccount(key).address, sealed: sealAgentKey(master, agentId, key) };
}

/**
 * The console's `AgentSigner`: decrypts the key for each signature and keeps it no longer. Callers decide
 * what may be signed (`agentTransactionRefusal`); this only signs.
 */
export function localAgentSigner(
  master: MasterKey,
  agent: { id: string; address: Address; sealedKey: string },
): AgentSigner {
  return {
    address: agent.address,
    async signTransaction(transaction: TransactionSerializable): Promise<Hex> {
      const account = privateKeyToAccount(openAgentKey(master, agent.id, agent.sealedKey));
      if (account.address !== agent.address) {
        throw new MasterKeyError("The decrypted key does not belong to this agent.");
      }
      return account.signTransaction(transaction);
    },
  };
}
