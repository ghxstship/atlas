/**
 * Wallet passes (A93, RRR-138; Section 11.10 item 14): the Apple pass and its CMS signature, the Google
 * Wallet link, and the wallet-pass function's answers. Every key and certificate here is made at run time
 * for the test; the fake signers stand in for the owner's.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readZipDirectory } from "../src/scanning/content.ts";
import {
  buildPkpass,
  passJson,
  readAppleWalletEnv,
  unconfiguredPassSigner,
  webCryptoPassSigner,
  type PassSigner,
  type WalletPass,
} from "../src/wallet/apple.ts";
import { cssTriple, ON_ACCENT, PLATFORM_ACCENT, passBackground } from "../src/wallet/colors.ts";
import {
  children,
  context,
  integer,
  issuerAndSerial,
  NULL,
  oid,
  pemToDer,
  pkcs8Of,
  raw,
  readElement,
  sequence,
  setOf,
  tlv,
  utcTime,
} from "../src/wallet/der.ts";
import { crc32, sha1Hex, solidPng, storedZip } from "../src/wallet/files.ts";
import {
  base64Url,
  genericObject,
  googleSaveUrl,
  readGoogleWalletEnv,
  unconfiguredJwtSigner,
  webCryptoJwtSigner,
  type JwtSigner,
} from "../src/wallet/google.ts";
import {
  callerPassLoader,
  parseWalletRequest,
  passFromRow,
  walletPassResponse,
  type WalletDeps,
} from "../src/wallet/handler.ts";

/** The labels Compass sends from its catalog (compass.wallet), in English and Spanish. */
const labels = {
  holder: "Name",
  credential: "Credential",
  role: "Role",
  project: "Project",
  starts: "Starts",
  ends: "Ends",
  validUntil: "Valid until",
  organization: "Organization",
};
const spanish = {
  holder: "Nombre",
  credential: "Credencial",
  role: "Puesto",
  project: "Proyecto",
  starts: "Empieza",
  ends: "Termina",
  validUntil: "Válida hasta",
  organization: "Organización",
};
const credential: WalletPass = {
  kind: "credential",
  serial: "01920000-0000-7000-8000-000000000001",
  orgName: "Harbor Stages",
  accentHex: "#B45309",
  title: "Crew",
  holderName: "Riley Park",
  projectName: "Pier Week",
  barcode: "XOSCR1:CR-000042",
  startsAt: "2027-06-01T12:00:00Z",
  endsAt: "2027-07-01T12:00:00Z",
  timeZone: "America/Los_Angeles",
  voided: false,
};
const shift: WalletPass = {
  ...credential,
  kind: "shift",
  title: "Head Rigger",
  barcode: null,
  endsAt: "2027-06-01T20:00:00Z",
};
const config = { passTypeIdentifier: "pass.example.test", teamIdentifier: "TEAMID1234" };

/** A test-only signer: records what it was asked to sign and answers fixed bytes. */
function fakeSigner(): PassSigner & { signed: Uint8Array[] } {
  const signed: Uint8Array[] = [];
  return {
    configured: true,
    signed,
    sign: (manifest) => {
      signed.push(manifest);
      return Promise.resolve(Uint8Array.of(0x30, 0x03, 0x02, 0x01, 0x01));
    },
  };
}

function fakeJwt(): JwtSigner & { claims: Record<string, unknown>[] } {
  const claims: Record<string, unknown>[] = [];
  return {
    configured: true,
    claims,
    sign: (c) => {
      claims.push({ ...c });
      return Promise.resolve("header.payload.signature");
    },
  };
}

/** The element at an index, or a failed test when there is none. */
function at<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) throw new Error(`no element ${String(index)}`);
  return item;
}

function pem(label: string, der: Uint8Array): string {
  const b64 = Buffer.from(der).toString("base64");
  return `-----BEGIN ${label}-----\n${b64.replace(/(.{64})/g, "$1\n")}\n-----END ${label}-----\n`;
}

const SHA256_RSA = "1.2.840.113549.1.1.11";

/** A self-signed certificate made at run time (the test stands in for the owner's Pass Type ID). */
async function selfSigned(name: string, keys: CryptoKeyPair, serial: number): Promise<Uint8Array> {
  const cn = sequence(setOf(sequence(oid("2.5.4.3"), tlv(0x0c, new TextEncoder().encode(name)))));
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey));
  const tbs = sequence(
    context(0, integer(2)),
    integer(serial),
    sequence(oid(SHA256_RSA), NULL),
    cn,
    sequence(utcTime(new Date("2026-01-01T00:00:00Z")), utcTime(new Date("2036-01-01T00:00:00Z"))),
    cn,
    spki,
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, tbs.slice()),
  );
  return sequence(tbs, sequence(oid(SHA256_RSA), NULL), tlv(0x03, Uint8Array.of(0), signature));
}

async function testKeys(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: Uint8Array.of(1, 0, 1),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
}

describe("the Apple pass", () => {
  it("lays out a credential as a badge with the gate's barcode, in the org's accent", () => {
    const json = passJson(credential, config, labels);
    expect(json).toMatchObject({
      formatVersion: 1,
      passTypeIdentifier: "pass.example.test",
      teamIdentifier: "TEAMID1234",
      serialNumber: `credential-${credential.serial}`,
      organizationName: "Harbor Stages",
      backgroundColor: cssTriple("#B45309"),
      foregroundColor: cssTriple(ON_ACCENT),
      voided: false,
      expirationDate: "2027-07-01T12:00:00Z",
      sharingProhibited: true,
      barcodes: [
        {
          format: "PKBarcodeFormatQR",
          message: "XOSCR1:CR-000042",
          altText: "CR-000042",
          messageEncoding: "iso-8859-1",
        },
      ],
      generic: {
        primaryFields: [{ key: "holder", label: "Name", value: "Riley Park" }],
        secondaryFields: [{ key: "credential", label: "Credential", value: "Crew" }],
      },
    });
  });

  it("lays out a shift as an event ticket, relevant at its start, with no barcode", () => {
    const json = passJson(shift, config, spanish);
    expect(json["relevantDate"]).toBe(shift.startsAt);
    expect(json["barcodes"]).toBeUndefined();
    expect(json["eventTicket"]).toMatchObject({
      primaryFields: [{ key: "role", label: "Puesto", value: "Head Rigger" }],
      secondaryFields: [
        { key: "starts", label: "Empieza", value: shift.startsAt },
        { key: "ends", label: "Termina", value: shift.endsAt },
      ],
    });
  });

  it("falls back to the platform accent when the org's accent is missing or white labels fail on it", () => {
    expect(passBackground(null)).toBe(PLATFORM_ACCENT);
    expect(passBackground("#FFD400")).toBe(PLATFORM_ACCENT);
    expect(passBackground("not a color")).toBe(PLATFORM_ACCENT);
    expect(passBackground("#b45309")).toBe("#B45309");
    expect(PLATFORM_ACCENT).toMatch(/^#[0-9A-F]{6}$/);
    expect(
      passJson({ ...credential, accentHex: "#FFD400", voided: true, endsAt: null }, config, labels),
    ).toMatchObject({
      backgroundColor: cssTriple(PLATFORM_ACCENT),
      voided: true,
    });
  });

  it("zips pass.json, the icons, a manifest of their SHA-1 digests and the signature of the manifest", async () => {
    const signer = fakeSigner();
    const pkpass = await buildPkpass(credential, config, labels, signer);
    const entries = readZipDirectory(pkpass);
    if (typeof entries === "string") throw new Error(entries);
    expect(entries.map((e) => e.name)).toEqual([
      "pass.json",
      "icon.png",
      "icon@2x.png",
      "icon@3x.png",
      "manifest.json",
      "signature",
    ]);
    const manifest = JSON.parse(new TextDecoder().decode(signer.signed[0])) as Record<
      string,
      string
    >;
    expect(Object.keys(manifest)).toEqual(["pass.json", "icon.png", "icon@2x.png", "icon@3x.png"]);
    expect(manifest["icon.png"]).toBe(await sha1Hex(solidPng(29, "#B45309")));
    await expect(buildPkpass(credential, config, labels, unconfiguredPassSigner)).rejects.toThrow(
      /not configured/,
    );
    await expect(unconfiguredPassSigner.sign(new Uint8Array())).rejects.toThrow(/not configured/);
  });

  it("signs the manifest with a CMS signature Wallet can check", async () => {
    const keys = await testKeys();
    const certificate = await selfSigned("Pass Type ID: pass.example.test", keys, 4242);
    const wwdr = await selfSigned("Test WWDR", keys, 7);
    const privateKey = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
    const signer = webCryptoPassSigner(
      {
        certificatePem: pem("CERTIFICATE", certificate),
        privateKeyPem: pem("PRIVATE KEY", privateKey),
        wwdrPem: pem("CERTIFICATE", wwdr),
      },
      () => new Date("2027-06-01T12:00:00Z"),
    );
    const manifest = new TextEncoder().encode('{"pass.json":"abc"}');
    const cms = await signer.sign(manifest);
    // ContentInfo(signedData) -> [0] -> SignedData; its last child is the SignerInfo set.
    const info = readElement(cms, 0);
    const wrapper = at(children(cms, info), 1);
    const signedData = children(cms, at(children(cms, wrapper), 0));
    const certs = children(cms, at(signedData, 3));
    expect(certs.map((c) => raw(cms, c))).toEqual([certificate, wwdr]);
    const signerInfo = children(cms, at(children(cms, at(signedData, 4)), 0));
    const sid = children(cms, at(signerInfo, 1));
    const expected = issuerAndSerial(certificate);
    expect(raw(cms, at(sid, 0))).toEqual(expected.issuer);
    expect(raw(cms, at(sid, 1))).toEqual(expected.serial);
    // The signature covers the signed attributes re-tagged as a SET, and they carry the manifest's digest.
    const attrs = raw(cms, at(signerInfo, 3)).slice();
    attrs[0] = 0x31;
    const sigElement = at(signerInfo, 5);
    const signature = cms.slice(sigElement.contentStart, sigElement.end);
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", keys.publicKey, signature, attrs)).toBe(
      true,
    );
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", manifest));
    expect(Buffer.from(attrs).includes(Buffer.from(digest))).toBe(true);
    // Where OpenSSL is installed, it checks the detached signature too.
    const dir = mkdtempSync(join(tmpdir(), "a93-pass-"));
    writeFileSync(join(dir, "signature"), cms);
    writeFileSync(join(dir, "manifest.json"), manifest);
    let opensslChecked = true;
    try {
      execFileSync(
        "openssl",
        [
          "smime",
          "-verify",
          "-binary",
          "-inform",
          "DER",
          "-noverify",
          "-in",
          join(dir, "signature"),
          "-content",
          join(dir, "manifest.json"),
          "-out",
          join(dir, "out"),
        ],
        { stdio: "pipe" },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") opensslChecked = false;
      else throw error;
    }
    expect(typeof opensslChecked).toBe("boolean");
    // PKCS #1 keys are accepted too.
    const pkcs1 = raw(privateKey, at(children(privateKey, readElement(privateKey, 0)), 2));
    const inner = pkcs1.subarray(readElement(pkcs1, 0).contentStart);
    expect(pkcs8Of(pem("RSA PRIVATE KEY", inner))).toEqual(privateKey);
    // The settings read from the function's secrets, and refuse values not yet filled in.
    expect(
      readAppleWalletEnv({
        APPLE_PASS_TYPE_ID: "pass.example.test",
        APPLE_TEAM_ID: "TEAMID1234",
        APPLE_PASS_CERT_PEM: pem("CERTIFICATE", certificate),
        APPLE_PASS_KEY_PEM: pem("PRIVATE KEY", privateKey),
        APPLE_WWDR_CERT_PEM: pem("CERTIFICATE", wwdr),
      })?.signer.configured,
    ).toBe(true);
    expect(
      readAppleWalletEnv({
        APPLE_PASS_TYPE_ID: "<pass type id>",
        APPLE_TEAM_ID: "<10 characters>",
      }),
    ).toBeNull();
    expect(
      readAppleWalletEnv({
        APPLE_PASS_TYPE_ID: "pass.example.test",
        APPLE_TEAM_ID: "TEAMID1234",
        APPLE_PASS_CERT_PEM: "x",
        APPLE_WWDR_CERT_PEM: "y",
      }),
    ).toBeNull();
    expect(
      readAppleWalletEnv({
        APPLE_PASS_TYPE_ID: "pass.example.test",
        APPLE_TEAM_ID: "TEAMID1234",
        APPLE_PASS_CERT_PEM: pem("CERTIFICATE", certificate),
        APPLE_WWDR_CERT_PEM: pem("CERTIFICATE", wwdr),
        APPLE_PASS_KEY_PEM: "none",
      }),
    ).toBeNull();
  });
});

describe("the Google Wallet link", () => {
  it("puts a Generic object for the pass in a Save to Google Wallet JWT", async () => {
    const signer = fakeJwt();
    const url = await googleSaveUrl(
      credential,
      {
        issuerId: "3388000000012345678",
        serviceAccountEmail: "wallet@example-project.iam.gserviceaccount.com",
      },
      labels,
      "en",
      signer,
      () => 1_800_000_000_000,
    );
    expect(url).toBe("https://pay.google.com/gp/v/save/header.payload.signature");
    expect(signer.claims[0]).toMatchObject({
      iss: "wallet@example-project.iam.gserviceaccount.com",
      aud: "google",
      typ: "savetowallet",
      iat: 1_800_000_000,
      payload: {
        genericClasses: [{ id: "3388000000012345678.xos_compass_credential" }],
        genericObjects: [
          {
            id: `3388000000012345678.credential-${credential.serial}`,
            state: "ACTIVE",
            hexBackgroundColor: "#B45309",
            barcode: { type: "QR_CODE", value: "XOSCR1:CR-000042", alternateText: "CR-000042" },
          },
        ],
      },
    });
    const ticket = genericObject(
      { ...shift, voided: true, endsAt: null },
      { issuerId: "1", serviceAccountEmail: "x" },
      labels,
      "en",
    );
    expect(ticket.object).toMatchObject({
      state: "INACTIVE",
      header: { defaultValue: { value: "Head Rigger" } },
    });
    expect(ticket.object["barcode"]).toBeUndefined();
    await expect(
      googleSaveUrl(
        credential,
        { issuerId: "1", serviceAccountEmail: "x" },
        labels,
        "en",
        unconfiguredJwtSigner,
      ),
    ).rejects.toThrow(/not configured/);
    await expect(unconfiguredJwtSigner.sign({})).rejects.toThrow();
  });

  it("signs the JWT with RS256 from the service account key", async () => {
    const keys = await testKeys();
    const privateKey = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
    const jwt = await webCryptoJwtSigner(pem("PRIVATE KEY", privateKey)).sign({ aud: "google" });
    const parts = jwt.split(".");
    const [header, payload, signature] = [at(parts, 0), at(parts, 1), at(parts, 2)];
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({ aud: "google" });
    expect(
      await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        keys.publicKey,
        Buffer.from(signature, "base64url"),
        new TextEncoder().encode(`${header}.${payload}`),
      ),
    ).toBe(true);
    expect(base64Url(Uint8Array.of(0xfb, 0xff))).toBe("-_8");
    const env = readGoogleWalletEnv({
      GOOGLE_WALLET_ISSUER_ID: "3388000000012345678",
      GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL: "wallet@example-project.iam.gserviceaccount.com",
      GOOGLE_WALLET_PRIVATE_KEY_PEM: pem("PRIVATE KEY", privateKey).replace(/\n/g, "\\n"),
    });
    expect(env?.signer.configured).toBe(true);
    expect(readGoogleWalletEnv({ GOOGLE_WALLET_ISSUER_ID: "<issuer id>" })).toBeNull();
    expect(
      readGoogleWalletEnv({
        GOOGLE_WALLET_ISSUER_ID: "3388000000012345678",
        GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL: "wallet@example-project.iam.gserviceaccount.com",
      }),
    ).toBeNull();
  });
});

describe("the wallet-pass function", () => {
  const deps = (over: Partial<WalletDeps> = {}): WalletDeps => ({
    loadPass: (kind, id) =>
      Promise.resolve(
        id === credential.serial ? (kind === "credential" ? credential : shift) : null,
      ),
    apple: { config, signer: fakeSigner() },
    google: {
      config: {
        issuerId: "3388000000012345678",
        serviceAccountEmail: "wallet@example-project.iam.gserviceaccount.com",
      },
      signer: fakeJwt(),
    },
    ...over,
  });

  it("answers a signed pkpass for Apple Wallet and a save link for Google Wallet", async () => {
    const apple = await walletPassResponse(
      { kind: "credential", id: credential.serial, platform: "apple", labels },
      deps(),
    );
    expect(apple.status).toBe(200);
    expect(apple.headers["content-type"]).toBe("application/vnd.apple.pkpass");
    expect(apple.headers["cache-control"]).toBe("no-store");
    expect(apple.body).toBeInstanceOf(Uint8Array);
    const google = await walletPassResponse(
      { kind: "shift", id: credential.serial, platform: "google", locale: "es-US", labels },
      deps(),
    );
    expect(JSON.parse(google.body as string)).toEqual({
      saveUrl: "https://pay.google.com/gp/v/save/header.payload.signature",
    });
  });

  it("refuses a bad request, a pass that is not the caller's, and a wallet that is not set up", async () => {
    expect((await walletPassResponse({ kind: "ticket" }, deps())).status).toBe(422);
    const missing = await walletPassResponse(
      { kind: "credential", id: "01920000-0000-7000-8000-00000000ffff", platform: "apple", labels },
      deps(),
    );
    expect(missing.status).toBe(404);
    const off = await walletPassResponse(
      { kind: "credential", id: credential.serial, platform: "apple", labels },
      deps({ apple: null }),
    );
    expect(off.status).toBe(503);
    expect(JSON.parse(off.body as string)).toMatchObject({
      reason: "wallet_not_configured",
      status: 503,
    });
    const unsigned = await walletPassResponse(
      { kind: "credential", id: credential.serial, platform: "google", labels },
      deps({
        google: {
          config: { issuerId: "1", serviceAccountEmail: "x" },
          signer: unconfiguredJwtSigner,
        },
      }),
    );
    expect(unsigned.status).toBe(503);
  });

  it("checks the request without a parser library: kind, wallet, id, language and every label", () => {
    const ok = { kind: "credential", id: credential.serial, platform: "apple", labels };
    expect(parseWalletRequest(ok)).toEqual({ ...ok, locale: "en-US" });
    expect(parseWalletRequest({ ...ok, locale: "es-US" })?.locale).toBe("es-US");
    for (const bad of [
      null,
      "text",
      { ...ok, kind: "ticket" },
      { ...ok, platform: "samsung" },
      { ...ok, id: "not-a-uuid" },
      { ...ok, locale: "Spanish!" },
      { ...ok, labels: null },
      { ...ok, labels: { ...labels, holder: "" } },
      { ...ok, labels: { ...labels, project: "x".repeat(61) } },
      { kind: "shift", id: credential.serial, platform: "google" },
    ])
      expect(parseWalletRequest(bad)).toBeNull();
  });

  it("reads the caller's own pass over PostgREST with the caller's token, never the service role", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const answer = (status: number, body: unknown) =>
      (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(body), { status });
      }) as unknown as typeof fetch;
    const load = callerPassLoader({
      supabaseUrl: "https://api.example.test/",
      anonKey: "public-anon-key",
      authorization: "Bearer caller-token",
      fetch: answer(200, [
        { kind: "shift", serial: credential.serial, starts_at: credential.startsAt, voided: false },
      ]),
    });
    expect(await load("shift", credential.serial)).toMatchObject({ kind: "shift", voided: false });
    expect(calls[0]?.url).toBe("https://api.example.test/rest/v1/rpc/my_wallet_pass");
    expect(calls[0]?.init.headers).toMatchObject({
      apikey: "public-anon-key",
      authorization: "Bearer caller-token",
      "content-profile": "app",
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      p_kind: "shift",
      p_id: credential.serial,
    });
    const none = callerPassLoader({
      supabaseUrl: "https://api.example.test",
      anonKey: "k",
      authorization: "Bearer t",
      fetch: answer(200, []),
    });
    expect(await none("credential", credential.serial)).toBeNull();
    const refused = callerPassLoader({
      supabaseUrl: "https://api.example.test",
      anonKey: "k",
      authorization: "Bearer t",
      fetch: answer(401, { message: "JWT expired" }),
    });
    await expect(refused("credential", credential.serial)).rejects.toThrow(/HTTP 401/);
  });

  it("reads app.my_wallet_pass rows", () => {
    expect(
      passFromRow({
        kind: "credential",
        serial: credential.serial,
        org_name: "Harbor Stages",
        accent_hex: null,
        title: "Crew",
        holder_name: "Riley Park",
        project_name: "Pier Week",
        barcode: "XOSCR1:CR-000042",
        starts_at: credential.startsAt,
        ends_at: null,
        time_zone: "America/Los_Angeles",
        voided: true,
      }),
    ).toMatchObject({ kind: "credential", accentHex: null, endsAt: null, voided: true });
    expect(passFromRow(null)).toBeNull();
    expect(passFromRow({ kind: "ticket", serial: "x", starts_at: "y" })).toBeNull();
    expect(passFromRow({ kind: "shift", serial: "x", starts_at: "y" })).toMatchObject({
      orgName: "",
      timeZone: "UTC",
    });
  });
});

describe("pass files and DER", () => {
  it("writes PNGs and zips Wallet reads", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    const png = solidPng(3, "#B45309");
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const idatAt = Buffer.from(png).indexOf("IDAT");
    const length = new DataView(png.buffer, png.byteOffset + idatAt - 4, 4).getUint32(0);
    const pixels = inflateSync(png.subarray(idatAt + 4, idatAt + 4 + length));
    expect([...pixels.subarray(0, 4)]).toEqual([0, 0xb4, 0x53, 0x09]);
    expect(pixels.length).toBe(3 * (1 + 9));
    // A large icon spans several stored deflate blocks.
    const big = solidPng(200, "#000000");
    const bigAt = Buffer.from(big).indexOf("IDAT");
    const bigLength = new DataView(big.buffer, big.byteOffset + bigAt - 4, 4).getUint32(0);
    expect(inflateSync(big.subarray(bigAt + 4, bigAt + 4 + bigLength)).length).toBe(200 * 601);
    const zip = storedZip([{ name: "a.txt", data: new TextEncoder().encode("hello") }]);
    const entries = readZipDirectory(zip);
    expect(
      typeof entries === "string" ? entries : entries.map((e) => [e.name, e.uncompressedSize]),
    ).toEqual([["a.txt", 5]]);
  });

  it("encodes the DER the signature needs and refuses what is not a certificate", () => {
    expect([...oid("1.2.840.113549.1.7.2")]).toEqual([
      0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02,
    ]);
    expect([...integer(128)]).toEqual([0x02, 0x02, 0x00, 0x80]);
    expect([...integer(0)]).toEqual([0x02, 0x01, 0x00]);
    const long = tlv(0x04, new Uint8Array(300));
    expect([...long.subarray(0, 4)]).toEqual([0x04, 0x82, 0x01, 0x2c]);
    expect(readElement(long, 0)).toMatchObject({ contentStart: 4, end: 304 });
    expect(() => readElement(Uint8Array.of(0x04), 0)).toThrow(/truncated/);
    expect(() => readElement(Uint8Array.of(0x04, 0x05, 0x00), 0)).toThrow(/past the end/);
    expect(() => issuerAndSerial(sequence(sequence(integer(1))))).toThrow(/not a certificate/);
    expect(() => issuerAndSerial(sequence())).toThrow(/not a certificate/);
    expect(() => pemToDer("-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----")).toThrow(
      /empty/,
    );
    expect([...utcTime(new Date("2027-06-01T12:34:56Z"))].slice(2)).toEqual([
      ...new TextEncoder().encode("270601123456Z"),
    ]);
  });
});
