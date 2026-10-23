import { afterEach, describe, expect, it, vi } from "vitest";
import {
  base64UrlToBytes,
  binaryToJson,
  bytesToBase64Url,
  createCredential,
  creationOptionsFromJson,
  credentialToJson,
  getCredential,
  requestOptionsFromJson,
  webAuthnAvailable,
} from "../src/webauthn-json.ts";

const bytes = (...values: number[]) => new Uint8Array(values);
const buffer = (...values: number[]) => bytes(...values).buffer;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("base64url", () => {
  it("round-trips bytes without padding", () => {
    const value = bytes(251, 255, 0, 1, 2);
    const encoded = bytesToBase64Url(value);
    expect(encoded).toBe("-_8AAQI");
    expect([...base64UrlToBytes(encoded)]).toEqual([...value]);
  });

  it("turns nested binary fields into strings and leaves the rest", () => {
    expect(
      binaryToJson({
        challenge: buffer(1, 2, 3),
        user: { id: bytes(4), name: "a" },
        list: [buffer(5)],
        n: 1,
      }),
    ).toEqual({ challenge: "AQID", user: { id: "BA", name: "a" }, list: ["BQ"], n: 1 });
  });
});

describe("options for the browser", () => {
  it("decodes the binary fields of creation options", () => {
    const options = creationOptionsFromJson({
      rp: { id: "localhost", name: "XOS" },
      user: { id: "BA", name: "a", displayName: "a" },
      challenge: "AQID",
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      excludeCredentials: [{ id: "BQ", type: "public-key", transports: ["usb"] }],
    });
    expect([...(options["challenge"] as Uint8Array)]).toEqual([1, 2, 3]);
    expect([...(options["user"] as { id: Uint8Array }).id]).toEqual([4]);
    expect(options["excludeCredentials"]).toMatchObject([
      { type: "public-key", transports: ["usb"] },
    ]);
  });

  it("decodes the binary fields of request options", () => {
    const options = requestOptionsFromJson({
      challenge: "AQID",
      rpId: "localhost",
      allowCredentials: [{ id: "BQ", type: "public-key" }],
    });
    expect([...(options["challenge"] as Uint8Array)]).toEqual([1, 2, 3]);
    expect(options["rpId"]).toBe("localhost");
    expect([...((options["allowCredentials"] as { id: Uint8Array }[])[0]?.id ?? [])]).toEqual([5]);
  });
});

describe("credentials back to the server", () => {
  it("serializes an attestation by hand when the browser has no toJSON", () => {
    const json = credentialToJson({
      id: "AQ",
      rawId: buffer(1),
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: buffer(2),
        attestationObject: buffer(3),
        getTransports: () => ["internal"],
      },
      getClientExtensionResults: () => ({}),
    });
    expect(json).toEqual({
      id: "AQ",
      rawId: "AQ",
      type: "public-key",
      response: { clientDataJSON: "Ag", attestationObject: "Aw", transports: ["internal"] },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    });
  });

  it("serializes an assertion, and prefers the browser's own toJSON", () => {
    const assertion = credentialToJson({
      id: "AQ",
      rawId: buffer(1),
      response: {
        clientDataJSON: buffer(2),
        authenticatorData: buffer(3),
        signature: buffer(4),
        userHandle: buffer(5),
      },
      getClientExtensionResults: () => ({}),
    });
    expect(assertion.response).toEqual({
      clientDataJSON: "Ag",
      authenticatorData: "Aw",
      signature: "BA",
      userHandle: "BQ",
    });
    const own = { id: "x" };
    expect(
      credentialToJson({
        id: "x",
        rawId: buffer(),
        response: { clientDataJSON: buffer() },
        getClientExtensionResults: () => ({}),
        toJSON: () => own,
      }),
    ).toBe(own);
  });
});

describe("ceremonies", () => {
  const options = {
    rp: { name: "XOS" },
    user: { id: "BA", name: "a", displayName: "a" },
    challenge: "AQID",
    pubKeyCredParams: [{ type: "public-key" as const, alg: -7 }],
  };

  it("says unsupported where the browser has no WebAuthn", async () => {
    expect(webAuthnAvailable()).toBe(false);
    expect(await createCredential(options)).toEqual({ ok: false, reason: "unsupported" });
  });

  it("returns the credential, or says cancelled or failed", async () => {
    const credential = {
      id: "AQ",
      rawId: buffer(1),
      response: { clientDataJSON: buffer(2), attestationObject: buffer(3) },
      getClientExtensionResults: () => ({}),
    };
    const dismissed = Object.assign(new Error("dismissed"), { name: "NotAllowedError" });
    const create = vi
      .fn()
      .mockResolvedValueOnce(credential)
      .mockRejectedValueOnce(dismissed)
      .mockRejectedValueOnce(new Error("bad"));
    const get = vi.fn().mockResolvedValueOnce(null);
    vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
    vi.stubGlobal("navigator", { credentials: { create, get } });
    expect(webAuthnAvailable()).toBe(true);
    expect(await createCredential(options)).toMatchObject({ ok: true, credential: { id: "AQ" } });
    expect(await createCredential(options)).toEqual({ ok: false, reason: "cancelled" });
    expect(await createCredential(options)).toEqual({ ok: false, reason: "failed" });
    expect(await getCredential({ challenge: "AQID" })).toEqual({ ok: false, reason: "cancelled" });
  });
});
