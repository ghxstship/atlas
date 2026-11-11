import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  importProjectSigningKey,
  projectTokenSigner,
  ProjectSigningKeyError,
  signProjectToken,
} from "../src/jwt/project-token.ts";

// ADR 0168, D5: XOS signs its own tokens with a private JWK the project imported as a JWT signing key, never with the
// legacy JWT secret. Every key here is generated for the run.

const KID = "0192f1e2-7c3a-7b4d-9e8f-000000168001";
const claims = { sub: "person", role: "authenticated", exp: 2_000_000_000 };

const part = (token: string, index: number) => token.split(".")[index] ?? "";
const json = (segment: string) =>
  JSON.parse(Buffer.from(segment, "base64url").toString()) as unknown;

async function privateJwk(algorithm: EcKeyGenParams | RsaHashedKeyGenParams) {
  const pair = (await crypto.subtle.generateKey(algorithm, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { pair, raw: JSON.stringify({ ...jwk, kid: KID, key_ops: ["sign", "verify"] }) };
}

describe("an ES256 project key", () => {
  it("signs a token naming its kid that the public key verifies", async () => {
    const { pair, raw } = await privateJwk({ name: "ECDSA", namedCurve: "P-256" });
    const token = await projectTokenSigner(raw, { production: true })(claims);
    expect(json(part(token, 0))).toEqual({ alg: "ES256", typ: "JWT", kid: KID });
    expect(json(part(token, 1))).toEqual(claims);
    const signature = Buffer.from(part(token, 2), "base64url");
    expect(signature).toHaveLength(64);
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        pair.publicKey,
        signature,
        new TextEncoder().encode(`${part(token, 0)}.${part(token, 1)}`),
      ),
    ).toBe(true);
  });
});

describe("an RS256 project key", () => {
  it("signs a token the public key verifies", async () => {
    const { pair, raw } = await privateJwk({
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    });
    const token = await signProjectToken(
      claims,
      await importProjectSigningKey(raw, { production: true }),
    );
    expect(json(part(token, 0))).toEqual({ alg: "RS256", typ: "JWT", kid: KID });
    expect(
      await crypto.subtle.verify(
        { name: "RSASSA-PKCS1-v1_5" },
        pair.publicKey,
        Buffer.from(part(token, 2), "base64url"),
        new TextEncoder().encode(`${part(token, 0)}.${part(token, 1)}`),
      ),
    ).toBe(true);
  });
});

describe("what is refused", () => {
  const secret = Array.from({ length: 40 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");

  it("a shared secret in production, the legacy JWT secret's kind, without quoting it", async () => {
    const refusal = importProjectSigningKey(secret, { production: true });
    await expect(refusal).rejects.toThrow(ProjectSigningKeyError);
    await expect(refusal).rejects.toThrow(/shared secret/);
    await expect(importProjectSigningKey(secret, { production: true })).rejects.not.toThrow(secret);
  });

  it("a key without a kid, a public key and another curve", async () => {
    const { raw } = await privateJwk({ name: "ECDSA", namedCurve: "P-256" });
    const jwk = JSON.parse(raw) as Record<string, unknown>;
    const without = (name: string) => JSON.stringify({ ...jwk, [name]: undefined });
    await expect(importProjectSigningKey(without("kid"), { production: true })).rejects.toThrow(
      /kid/,
    );
    await expect(importProjectSigningKey(without("d"), { production: true })).rejects.toThrow(
      /public key/,
    );
    const p384 = await privateJwk({ name: "ECDSA", namedCurve: "P-384" });
    await expect(importProjectSigningKey(p384.raw, { production: true })).rejects.toThrow(/P-256/);
    await expect(importProjectSigningKey("{not json", { production: true })).rejects.toThrow(
      /not a JWK/,
    );
  });

  it("still reads the local stack's development secret outside production, as HS256", async () => {
    const token = await projectTokenSigner(secret, { production: false })(claims);
    expect(json(part(token, 0))).toEqual({ alg: "HS256", typ: "JWT" });
    expect(part(token, 2)).toBe(
      createHmac("sha256", secret)
        .update(`${part(token, 0)}.${part(token, 1)}`)
        .digest("base64url"),
    );
    await expect(importProjectSigningKey("short", { production: false })).rejects.toThrow(
      /too short/,
    );
  });
});
