/**
 * Apple Wallet passes for credentials and shift passes (A93, RRR-138; Section 11.10 item 14, Section 11.13:
 * the badge in one tap from the lock screen). A pass is a signed zip: pass.json, the images, manifest.json
 * (each file's SHA-1) and `signature`, a detached CMS signature of the manifest made with the Pass Type ID
 * certificate and Apple's WWDR intermediate.
 *
 * Signing is a seam (PassSigner). The real signer signs with Web Crypto from the owner's certificate and
 * key, held as Edge Function secrets and never in the repository; until they are set the signer reports
 * itself unconfigured and the function answers 503 wallet_not_configured. Tests use a fake signer built at
 * run time.
 */
import {
  concat,
  context,
  integer,
  issuerAndSerial,
  NULL,
  octetString,
  oid,
  pemToDer,
  pkcs8Of,
  sequence,
  setOf,
  utcTime,
} from "./der.ts";
import { cssTriple, ON_ACCENT, passBackground } from "./colors.ts";
import { sha1Hex, solidPng, storedZip } from "./files.ts";
import type { Rgba } from "./png.ts";

/** What one pass shows: a row of app.my_wallet_pass (1501), with its labels in the holder's language. */
export interface WalletPass {
  readonly kind: "credential" | "shift";
  /** The credential or shift id. */
  readonly serial: string;
  readonly orgName: string;
  /** The org's brand accent, #RRGGBB, or null for the platform's. */
  readonly accentHex: string | null;
  /** The credential category, or the shift's job title. */
  readonly title: string;
  readonly holderName: string;
  readonly projectName: string;
  /** The barcode payload: the badge's XOSCR1 code; null for a shift pass. */
  readonly barcode: string | null;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly timeZone: string;
  readonly voided: boolean;
  /** The org's logo in the org-brand bucket (its dark-theme logo, else its light one), or null for none. */
  readonly logoPath?: string | null;
}

export interface WalletLabels {
  readonly holder: string;
  readonly credential: string;
  readonly role: string;
  readonly project: string;
  readonly starts: string;
  readonly ends: string;
  readonly validUntil: string;
  readonly organization: string;
}

export interface ApplePassConfig {
  /** pass.<reverse domain>, registered by the owner in the Apple Developer account. */
  readonly passTypeIdentifier: string;
  /** The Apple Developer team id (10 characters). */
  readonly teamIdentifier: string;
}

/** Signs a pass manifest: a detached CMS (PKCS #7) signature, DER. */
export interface PassSigner {
  readonly configured: boolean;
  sign(manifest: Uint8Array): Promise<Uint8Array>;
}

/** The pass.json for a pass; with the org's logo as the logo image, the org's name is not repeated beside it. */
export function passJson(
  pass: WalletPass,
  config: ApplePassConfig,
  labels: WalletLabels,
  withLogo = false,
): Record<string, unknown> {
  const color = passBackground(pass.accentHex);
  const date = (key: string, label: string, value: string) => ({
    key,
    label,
    value,
    dateStyle: "PKDateStyleMedium",
    timeStyle: "PKDateStyleShort",
  });
  const fields =
    pass.kind === "credential"
      ? {
          generic: {
            primaryFields: [{ key: "holder", label: labels.holder, value: pass.holderName }],
            secondaryFields: [{ key: "credential", label: labels.credential, value: pass.title }],
            auxiliaryFields: [
              { key: "project", label: labels.project, value: pass.projectName },
              ...(pass.endsAt
                ? [
                    {
                      ...date("validUntil", labels.validUntil, pass.endsAt),
                      timeStyle: "PKDateStyleNone",
                    },
                  ]
                : []),
            ],
            backFields: [{ key: "organization", label: labels.organization, value: pass.orgName }],
          },
        }
      : {
          eventTicket: {
            primaryFields: [{ key: "role", label: labels.role, value: pass.title }],
            secondaryFields: [
              date("starts", labels.starts, pass.startsAt),
              ...(pass.endsAt ? [date("ends", labels.ends, pass.endsAt)] : []),
            ],
            auxiliaryFields: [{ key: "project", label: labels.project, value: pass.projectName }],
            backFields: [
              { key: "holder", label: labels.holder, value: pass.holderName },
              { key: "organization", label: labels.organization, value: pass.orgName },
            ],
          },
        };
  return {
    formatVersion: 1,
    passTypeIdentifier: config.passTypeIdentifier,
    teamIdentifier: config.teamIdentifier,
    serialNumber: `${pass.kind}-${pass.serial}`,
    organizationName: pass.orgName,
    description: `${pass.title}, ${pass.projectName}`,
    ...(withLogo ? {} : { logoText: pass.orgName }),
    foregroundColor: cssTriple(ON_ACCENT),
    labelColor: cssTriple(ON_ACCENT),
    backgroundColor: cssTriple(color),
    sharingProhibited: true,
    voided: pass.voided,
    ...(pass.kind === "shift" ? { relevantDate: pass.startsAt } : {}),
    ...(pass.endsAt ? { expirationDate: pass.endsAt } : {}),
    ...(pass.barcode
      ? {
          barcodes: [
            {
              format: "PKBarcodeFormatQR",
              message: pass.barcode,
              messageEncoding: "iso-8859-1",
              altText: pass.barcode.replace(/^XOSCR1:/, ""),
            },
          ],
        }
      : {}),
    ...fields,
  };
}

export interface PassFile {
  readonly name: string;
  readonly data: Uint8Array;
}

/** Wallet's image sizes in points, drawn at 1x, 2x and 3x. */
const ICON = 29;
const LOGO = { width: 160, height: 50 };
const STRIP = { width: 375, height: 98 };
const SCALES = [1, 2, 3] as const;

function named(base: string, scale: number): string {
  return scale === 1 ? `${base}.png` : `${base}@${String(scale)}x.png`;
}

/**
 * The pass's images (A140). With the org's logo, read as a PNG: the icon is the logo on the pass color, the logo image
 * is the logo itself at the top of the pass, and a shift pass (an event ticket) carries a strip of the pass color
 * with the logo in its middle; Wallet has no strip for a generic pass. Without a logo it reads, the icon is the
 * accent color alone, as before.
 */
export async function passImages(
  pass: WalletPass,
  logo: Uint8Array | null,
): Promise<{ readonly files: readonly PassFile[]; readonly fromLogo: boolean }> {
  const color = passBackground(pass.accentHex);
  // The PNG code loads only for a pass with a logo, so the function's boot stays inside its budget.
  const png = logo ? await import("./png.ts") : null;
  const image: Rgba | null = png && logo ? await png.decodePng(logo) : null;
  if (!png || !image) {
    return {
      fromLogo: false,
      files: SCALES.map((s) => ({ name: named("icon", s), data: solidPng(ICON * s, color) })),
    };
  }
  const files: PassFile[] = [];
  for (const s of SCALES)
    files.push({
      name: named("icon", s),
      data: await png.encodePng(png.centered(image, ICON * s, ICON * s, color, 0.8)),
    });
  for (const s of SCALES) {
    const size = png.fit(image, LOGO.width * s, LOGO.height * s);
    const art = png.canvas(size.width, size.height, null);
    png.draw(art, image, 0, 0, size.width, size.height);
    files.push({ name: named("logo", s), data: await png.encodePng(art) });
  }
  if (pass.kind === "shift")
    for (const s of SCALES)
      files.push({
        name: named("strip", s),
        data: await png.encodePng(
          png.centered(image, STRIP.width * s, STRIP.height * s, color, 0.6),
        ),
      });
  return { files, fromLogo: true };
}

/**
 * The signed .pkpass bytes, its images drawn from the org's logo when given one Wallet can show (passImages).
 * Throws when the signer is not configured.
 */
export async function buildPkpass(
  pass: WalletPass,
  config: ApplePassConfig,
  labels: WalletLabels,
  signer: PassSigner,
  logo: Uint8Array | null = null,
): Promise<Uint8Array> {
  if (!signer.configured) throw new Error("The Apple Wallet signer is not configured.");
  const images = await passImages(pass, logo);
  const files = [
    {
      name: "pass.json",
      data: new TextEncoder().encode(
        JSON.stringify(passJson(pass, config, labels, images.fromLogo)),
      ),
    },
    ...images.files,
  ];
  const manifest: Record<string, string> = {};
  for (const file of files) manifest[file.name] = await sha1Hex(file.data);
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const signature = await signer.sign(manifestBytes);
  return storedZip([
    ...files,
    { name: "manifest.json", data: manifestBytes },
    { name: "signature", data: signature },
  ]);
}

const SHA256 = "2.16.840.1.101.3.4.2.1";
const RSA = "1.2.840.113549.1.1.1";
const DATA = "1.2.840.113549.1.7.1";
const SIGNED_DATA = "1.2.840.113549.1.7.2";
const CONTENT_TYPE = "1.2.840.113549.1.9.3";
const MESSAGE_DIGEST = "1.2.840.113549.1.9.4";
const SIGNING_TIME = "1.2.840.113549.1.9.5";

export interface AppleSignerKeys {
  /** The Pass Type ID certificate, PEM. */
  readonly certificatePem: string;
  /** Its private key, PEM (PKCS #8, or PKCS #1 "RSA PRIVATE KEY"). */
  readonly privateKeyPem: string;
  /** Apple's WWDR intermediate certificate, PEM. */
  readonly wwdrPem: string;
}

/**
 * The CMS SignedData Wallet checks: SHA-256, the signer certificate and the WWDR intermediate included, and
 * signed attributes (content type, signing time, message digest) signed with RSA (Web Crypto).
 */
export function webCryptoPassSigner(
  keys: AppleSignerKeys,
  now: () => Date = () => new Date(),
): PassSigner {
  return {
    configured: true,
    async sign(manifest) {
      const certificate = pemToDer(keys.certificatePem);
      const wwdr = pemToDer(keys.wwdrPem);
      const key = await crypto.subtle.importKey(
        "pkcs8",
        pkcs8Of(keys.privateKeyPem) as BufferSource,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", manifest as BufferSource),
      );
      const attributes = [
        sequence(oid(CONTENT_TYPE), setOf(oid(DATA))),
        sequence(oid(SIGNING_TIME), setOf(utcTime(now()))),
        sequence(oid(MESSAGE_DIGEST), setOf(octetString(digest))),
      ];
      // The signature covers the attributes encoded as a SET; the SignerInfo carries them as [0].
      const signedSet = setOf(...attributes);
      const signature = new Uint8Array(
        await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, signedSet as BufferSource),
      );
      const { issuer, serial } = issuerAndSerial(certificate);
      const signerInfo = sequence(
        integer(1),
        sequence(issuer, serial),
        sequence(oid(SHA256), NULL),
        concat(Uint8Array.of(0xa0), signedSet.subarray(1)),
        sequence(oid(RSA), NULL),
        octetString(signature),
      );
      const signedData = sequence(
        integer(1),
        setOf(sequence(oid(SHA256), NULL)),
        sequence(oid(DATA)),
        context(0, certificate, wwdr),
        setOf(signerInfo),
      );
      return sequence(oid(SIGNED_DATA), context(0, signedData));
    },
  };
}

/** A signer for a deployment without the owner's certificate: never signs. */
export const unconfiguredPassSigner: PassSigner = {
  configured: false,
  sign: () => Promise.reject(new Error("The Apple Wallet signer is not configured.")),
};

export interface AppleWalletEnv {
  readonly config: ApplePassConfig;
  readonly signer: PassSigner;
}

/**
 * The Apple Wallet settings from the Edge Function's secrets (owner steps: APPLE_PASS_TYPE_ID,
 * APPLE_TEAM_ID, APPLE_PASS_CERT_PEM, APPLE_PASS_KEY_PEM, APPLE_WWDR_CERT_PEM), or null while any is
 * missing or is not yet the real value (a sample such as `<10 characters>`).
 */
export function readAppleWalletEnv(
  env: Readonly<Record<string, string | undefined>>,
): AppleWalletEnv | null {
  const passTypeIdentifier = env["APPLE_PASS_TYPE_ID"] ?? "";
  const teamIdentifier = env["APPLE_TEAM_ID"] ?? "";
  const certificatePem = env["APPLE_PASS_CERT_PEM"] ?? "";
  const privateKeyPem = env["APPLE_PASS_KEY_PEM"] ?? "";
  const wwdrPem = env["APPLE_WWDR_CERT_PEM"] ?? "";
  if (!/^pass\.[A-Za-z0-9.-]+$/.test(passTypeIdentifier) || !/^[A-Z0-9]{10}$/.test(teamIdentifier))
    return null;
  if (![certificatePem, wwdrPem].every((p) => p.includes("BEGIN CERTIFICATE"))) return null;
  if (!privateKeyPem.includes("PRIVATE KEY")) return null;
  return {
    config: { passTypeIdentifier, teamIdentifier },
    signer: webCryptoPassSigner({ certificatePem, privateKeyPem, wwdrPem }),
  };
}
