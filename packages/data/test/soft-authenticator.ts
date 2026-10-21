import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import type {
  CreationOptionsJSON,
  CredentialJSON,
  RequestOptionsJSON,
} from "../src/webauthn-json.ts";

/**
 * A software WebAuthn authenticator (ES256, attestation "none") for tests against the local Supabase stack: it
 * answers registration and assertion options as a browser would, for the origin it is given. Keys live in memory
 * for one test run.
 */

function cbor(value: number | string | Buffer | Map<unknown, unknown>): Buffer {
  const head = (major: number, n: number) =>
    n < 24
      ? Buffer.from([(major << 5) | n])
      : n < 256
        ? Buffer.from([(major << 5) | 24, n])
        : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  const parts: Buffer[] = [head(5, value.size)];
  for (const [k, v] of value) {
    parts.push(cbor(k as never), cbor(v as never));
  }
  return Buffer.concat(parts);
}

const b64u = (bytes: Buffer) => bytes.toString("base64url");

interface Held {
  readonly credentialId: Buffer;
  readonly privateKey: KeyObject;
  readonly userHandle: string;
  counter: number;
}

export class SoftAuthenticator {
  private readonly held: Held[] = [];

  constructor(private readonly origin: string) {}

  create(options: CreationOptionsJSON): CredentialJSON {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const credentialId = randomBytes(16);
    const coseKey = cbor(
      new Map<number, number | Buffer>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x as string, "base64url")],
        [-3, Buffer.from(jwk.y as string, "base64url")],
      ]),
    );
    const rpIdHash = createHash("sha256")
      .update(options.rp.id ?? new URL(this.origin).hostname)
      .digest();
    const authData = Buffer.concat([
      rpIdHash,
      Buffer.from([0x45]),
      Buffer.alloc(4),
      Buffer.alloc(16),
      Buffer.from([credentialId.length >> 8, credentialId.length & 255]),
      credentialId,
      coseKey,
    ]);
    const clientData = Buffer.from(
      JSON.stringify({
        type: "webauthn.create",
        challenge: options.challenge,
        origin: this.origin,
      }),
    );
    this.held.push({ credentialId, privateKey, userHandle: options.user.id, counter: 0 });
    return {
      id: b64u(credentialId),
      rawId: b64u(credentialId),
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientData),
        attestationObject: b64u(
          cbor(
            new Map<string, string | Buffer | Map<unknown, unknown>>([
              ["fmt", "none"],
              ["attStmt", new Map()],
              ["authData", authData],
            ]),
          ),
        ),
        transports: ["internal"],
      },
    };
  }

  get(options: RequestOptionsJSON): CredentialJSON {
    const allowed = new Set((options.allowCredentials ?? []).map((c) => c.id));
    const held = this.held.find((h) => allowed.size === 0 || allowed.has(b64u(h.credentialId)));
    if (!held) throw new Error("no credential for these options");
    held.counter += 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(held.counter);
    const rpIdHash = createHash("sha256")
      .update(options.rpId ?? new URL(this.origin).hostname)
      .digest();
    const authData = Buffer.concat([rpIdHash, Buffer.from([0x05]), counter]);
    const clientData = Buffer.from(
      JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: this.origin }),
    );
    const signer = createSign("SHA256");
    signer.update(Buffer.concat([authData, createHash("sha256").update(clientData).digest()]));
    return {
      id: b64u(held.credentialId),
      rawId: b64u(held.credentialId),
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientData),
        authenticatorData: b64u(authData),
        signature: b64u(signer.sign(held.privateKey)),
        userHandle: held.userHandle,
      },
    };
  }
}
