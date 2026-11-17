import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoCBOR } from "@simplewebauthn/server/helpers";

/**
 * A software passkey for server tests: it answers the console's registration and sign-in options the way a
 * platform authenticator does (ES256, attestation "none", user present and verified), so the ceremonies run
 * through SimpleWebAuthn's real verification. The browser end to end tests use Playwright's virtual
 * authenticator instead.
 */
export class SoftPasskey {
  readonly credentialId = randomBytes(16);
  private readonly privateKey: KeyObject;
  private readonly cose: Uint8Array;
  private counter = 0;
  private userHandle: string | null = null;

  constructor(private readonly origin: string) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    const coordinate = (value: string | undefined) => new Uint8Array(Buffer.from(value ?? "", "base64url"));
    this.cose = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, coordinate(jwk.x)],
        [-3, coordinate(jwk.y)],
      ]),
    );
  }

  get id(): string {
    return this.credentialId.toString("base64url");
  }

  /** A new passkey for the registration options, as `navigator.credentials.create` returns it. */
  create(
    options: PublicKeyCredentialCreationOptionsJSON,
    overrides: { origin?: string; rpId?: string } = {},
  ): RegistrationResponseJSON {
    this.userHandle = options.user.id;
    const clientDataJSON = this.clientData("webauthn.create", options.challenge, overrides.origin);
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      this.authenticatorData(overrides.rpId ?? options.rp.id ?? "", 0x45),
      Buffer.alloc(16), // AAGUID: none
      idLength,
      this.credentialId,
      Buffer.from(this.cose),
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string, string | Uint8Array | Map<string, string>>([
        ["fmt", "none"],
        ["attStmt", new Map<string, string>()],
        ["authData", new Uint8Array(authData)],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: clientDataJSON.toString("base64url"),
        attestationObject: Buffer.from(attestationObject).toString("base64url"),
        transports: ["internal"],
      },
      clientExtensionResults: {},
    };
  }

  /** A signed answer to the sign-in options, as `navigator.credentials.get` returns it. */
  get(
    options: PublicKeyCredentialRequestOptionsJSON,
    overrides: { origin?: string; rpId?: string } = {},
  ): AuthenticationResponseJSON {
    const clientDataJSON = this.clientData("webauthn.get", options.challenge, overrides.origin);
    const authData = this.authenticatorData(overrides.rpId ?? options.rpId ?? "", 0x05);
    const signature = sign(
      "sha256",
      Buffer.concat([authData, createHash("sha256").update(clientDataJSON).digest()]),
      this.privateKey,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: clientDataJSON.toString("base64url"),
        authenticatorData: authData.toString("base64url"),
        signature: signature.toString("base64url"),
        ...(this.userHandle === null ? {} : { userHandle: this.userHandle }),
      },
      clientExtensionResults: {},
    };
  }

  private clientData(type: string, challenge: string, origin?: string): Buffer {
    return Buffer.from(
      JSON.stringify({ type, challenge, origin: origin ?? this.origin, crossOrigin: false }),
    );
  }

  /** The RP id's hash, the flags (user present, verified, and with 0x40 a new credential) and the counter. */
  private authenticatorData(rpId: string, flags: number): Buffer {
    this.counter += 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    return Buffer.concat([createHash("sha256").update(rpId).digest(), Buffer.from([flags]), counter]);
  }
}
