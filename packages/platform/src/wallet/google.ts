/**
 * Google Wallet passes for credentials and shift passes (A93, RRR-138; Section 11.10 item 14). A pass is a
 * Generic object inside a "Save to Google Wallet" JWT, signed RS256 with the issuer's service account key;
 * Compass opens https://pay.google.com/gp/v/save/<jwt> and Google Wallet adds it.
 *
 * Signing is a seam (JwtSigner): the real signer uses Web Crypto with the service account key, an owner
 * secret; until it is set the function answers 503 wallet_not_configured. Tests use a fake signer.
 */
import type { WalletLabels, WalletPass } from "./apple.ts";
import { passBackground } from "./colors.ts";
import { pkcs8Of } from "./der.ts";

export const GOOGLE_SAVE_URL = "https://pay.google.com/gp/v/save/";

export interface JwtSigner {
  readonly configured: boolean;
  /** The signed compact JWT for a claims object. */
  sign(claims: Readonly<Record<string, unknown>>): Promise<string>;
}

export interface GoogleWalletConfig {
  /** The Google Wallet issuer id (digits). */
  readonly issuerId: string;
  /** The service account the issuer authorized; the JWT's issuer. */
  readonly serviceAccountEmail: string;
}

export function base64Url(bytes: Uint8Array): string {
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const encode = (value: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(value)));

/** RS256 with Web Crypto from the service account's private key (PEM). */
export function webCryptoJwtSigner(privateKeyPem: string): JwtSigner {
  return {
    configured: true,
    async sign(claims) {
      const key = await crypto.subtle.importKey(
        "pkcs8",
        pkcs8Of(privateKeyPem) as BufferSource,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const input = `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}`;
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          "RSASSA-PKCS1-v1_5",
          key,
          new TextEncoder().encode(input) as BufferSource,
        ),
      );
      return `${input}.${base64Url(signature)}`;
    },
  };
}

export const unconfiguredJwtSigner: JwtSigner = {
  configured: false,
  sign: () => Promise.reject(new Error("The Google Wallet signer is not configured.")),
};

/** A Google Wallet id part: letters, digits, dot, dash and underscore. */
function idPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function text(language: string, value: string) {
  return { defaultValue: { language, value } };
}

/**
 * The Generic object and class for a pass. Google Wallet fetches the logo itself, so it takes the public URL of the
 * org's logo (A140), when it is a PNG.
 */
export function genericObject(
  pass: WalletPass,
  config: GoogleWalletConfig,
  labels: WalletLabels,
  language: string,
  logoUrl: string | null = null,
): { object: Record<string, unknown>; classId: string } {
  const classId = `${config.issuerId}.xos_compass_${pass.kind}`;
  const modules = [
    { id: "project", header: labels.project, body: pass.projectName },
    { id: "organization", header: labels.organization, body: pass.orgName },
    ...(pass.kind === "shift"
      ? [{ id: "starts", header: labels.starts, body: pass.startsAt }]
      : []),
  ];
  return {
    classId,
    object: {
      id: `${config.issuerId}.${idPart(`${pass.kind}-${pass.serial}`)}`,
      classId,
      state: pass.voided ? "INACTIVE" : "ACTIVE",
      cardTitle: text(language, pass.orgName),
      header: text(language, pass.kind === "credential" ? pass.holderName : pass.title),
      subheader: text(language, pass.kind === "credential" ? pass.title : pass.holderName),
      hexBackgroundColor: passBackground(pass.accentHex),
      ...(logoUrl
        ? {
            logo: {
              sourceUri: { uri: logoUrl },
              contentDescription: text(language, pass.orgName),
            },
          }
        : {}),
      ...(pass.barcode
        ? {
            barcode: {
              type: "QR_CODE",
              value: pass.barcode,
              alternateText: pass.barcode.replace(/^XOSCR1:/, ""),
            },
          }
        : {}),
      validTimeInterval: {
        start: { date: pass.startsAt },
        ...(pass.endsAt ? { end: { date: pass.endsAt } } : {}),
      },
      textModulesData: modules,
    },
  };
}

/** The "Save to Google Wallet" link for a pass. Throws when the signer is not configured. */
export async function googleSaveUrl(
  pass: WalletPass,
  config: GoogleWalletConfig,
  labels: WalletLabels,
  language: string,
  signer: JwtSigner,
  now: () => number = Date.now,
  logoUrl: string | null = null,
): Promise<string> {
  if (!signer.configured) throw new Error("The Google Wallet signer is not configured.");
  const { object, classId } = genericObject(pass, config, labels, language, logoUrl);
  const jwt = await signer.sign({
    iss: config.serviceAccountEmail,
    aud: "google",
    typ: "savetowallet",
    iat: Math.floor(now() / 1000),
    origins: [],
    payload: { genericClasses: [{ id: classId }], genericObjects: [object] },
  });
  return `${GOOGLE_SAVE_URL}${jwt}`;
}

export interface GoogleWalletEnv {
  readonly config: GoogleWalletConfig;
  readonly signer: JwtSigner;
}

/**
 * The Google Wallet settings from the Edge Function's secrets (owner steps: GOOGLE_WALLET_ISSUER_ID,
 * GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL, GOOGLE_WALLET_PRIVATE_KEY_PEM), or null while any is missing.
 */
export function readGoogleWalletEnv(
  env: Readonly<Record<string, string | undefined>>,
): GoogleWalletEnv | null {
  const issuerId = env["GOOGLE_WALLET_ISSUER_ID"] ?? "";
  const serviceAccountEmail = env["GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL"] ?? "";
  const privateKeyPem = (env["GOOGLE_WALLET_PRIVATE_KEY_PEM"] ?? "").replace(/\\n/g, "\n");
  if (
    !/^\d{6,30}$/.test(issuerId) ||
    !/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(serviceAccountEmail)
  )
    return null;
  if (!privateKeyPem.includes("PRIVATE KEY")) return null;
  return { config: { issuerId, serviceAccountEmail }, signer: webCryptoJwtSigner(privateKeyPem) };
}
