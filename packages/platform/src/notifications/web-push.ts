import { z } from "zod";

/**
 * Web Push to browsers (Section 4.10, finding A65-023, ADR 0052): RFC 8030 delivery, RFC 8291 message encryption
 * (aes128gcm, RFC 8188) and RFC 8292 VAPID, on Web Crypto alone, with no dependency. Atlas and Gateway register a
 * browser's subscription in app.push_subscriptions (1533); A80's claim lists it as a device with no token, and
 * dispatchPush (push.ts) sends it here with the VAPID keys of VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT.
 *
 * A push service answers each request at once and keeps no receipt: 201 Created means it took the message, 404 and
 * 410 mean the browser unsubscribed (recorded as DeviceNotRegistered, which revokes it), 413 means the message is too
 * big, and 429 or a server error is retried with backoff.
 */

/** A browser subscription as app.web_push_devices returns it. */
export interface WebPushDevice {
  readonly subscriptionId: string;
  readonly endpoint: string;
  /** The browser's P-256 public key, base64url (65 bytes uncompressed). */
  readonly p256dh: string;
  /** The browser's 16-byte authentication secret, base64url. */
  readonly auth: string;
  /** App whose service worker shows the push and opens its link. */
  readonly app: "Atlas" | "Gateway";
}

/** What the service worker shows: the JSON payload, encrypted for the browser. */
export interface WebPushPayload {
  readonly title: string;
  readonly body: string;
  /** Path on the subscribing app's own origin that a click opens. */
  readonly url: string;
  /** The notification id, so a second push of the same notification replaces the first. */
  readonly tag: string;
  readonly kind: string;
}

export interface WebPushOptions {
  /** Seconds the push service keeps trying an offline browser. */
  readonly ttl: number;
  readonly urgency: "high" | "normal";
}

export type WebPushResult =
  | { readonly status: "ok" }
  | { readonly status: "error"; readonly error: string | null; readonly message: string };

/** The push services, behind an interface so tests and local runs never reach the network. */
export interface WebPushClient {
  readonly name: string;
  send(
    device: WebPushDevice,
    payload: WebPushPayload,
    options: WebPushOptions,
  ): Promise<WebPushResult>;
}

// Bytes and base64url ----------------------------------------------------------------------------------------------

const encoder = new TextEncoder();

function bytes(length: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(length));
}

function concat(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = bytes(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return concat(encoder.encode(text));
}

export function base64UrlEncode(data: Uint8Array): string {
  let binary = "";
  for (const b of data) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> {
  const padded =
    text.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((text.length + 3) % 4);
  const binary = atob(padded);
  const out = bytes(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8),
  );
}

// RFC 8291 message encryption -------------------------------------------------------------------------------------

/** The record size written in the aes128gcm header; one record carries the whole message. */
const RECORD_SIZE = 4096;
/** Largest plaintext one record holds: the record size less the 16-byte tag and the 1-byte delimiter. */
export const WEB_PUSH_MAX_PAYLOAD = RECORD_SIZE - 17;

export interface EncryptOptions {
  /** Fixed salt and server keys, for tests against the RFC 8291 example only. */
  readonly salt?: Uint8Array<ArrayBuffer>;
  readonly serverKeys?: CryptoKeyPair;
}

/**
 * Encrypts a payload for one browser (RFC 8291 section 3.4): an ephemeral P-256 key agreement with the browser's
 * key, mixed with its authentication secret, gives the content key and nonce of a single aes128gcm record (RFC 8188),
 * whose header carries the salt and the ephemeral public key.
 */
export async function encryptWebPush(
  plaintext: Uint8Array,
  p256dh: string,
  auth: string,
  options: EncryptOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  if (plaintext.length > WEB_PUSH_MAX_PAYLOAD)
    throw new RangeError("The push message is too big for one record.");
  const browserKey = base64UrlDecode(p256dh);
  const authSecret = base64UrlDecode(auth);
  if (browserKey.length !== 65 || authSecret.length !== 16)
    throw new RangeError("The browser's keys are malformed.");
  const serverKeys =
    options.serverKeys ??
    ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair);
  const serverPublic = new Uint8Array(await crypto.subtle.exportKey("raw", serverKeys.publicKey));
  const browserPublic = await crypto.subtle.importKey(
    "raw",
    browserKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: browserPublic },
      serverKeys.privateKey,
      256,
    ),
  );
  const ikm = await hkdf(
    authSecret,
    shared,
    concat(utf8("WebPush: info\0"), browserKey, serverPublic),
    32,
  );
  const salt = options.salt ?? concat(crypto.getRandomValues(bytes(16)));
  const contentKey = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]);
  const record = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, tagLength: 128 },
      key,
      concat(plaintext, new Uint8Array([2])),
    ),
  );
  const header = bytes(16 + 4 + 1 + serverPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = serverPublic.length;
  header.set(serverPublic, 21);
  return concat(header, record);
}

// RFC 8292 VAPID ---------------------------------------------------------------------------------------------------

export interface VapidKeys {
  /** Uncompressed P-256 public key, base64url (87 characters). */
  readonly publicKey: string;
  /** P-256 private scalar, base64url (43 characters). */
  readonly privateKey: string;
  /** mailto: or https: contact the push services may reach. */
  readonly subject: string;
}

/** The VAPID Authorization header for an endpoint: an ES256 JWT for its origin, valid 12 hours, and the public key. */
export async function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  nowSeconds: number,
): Promise<string> {
  const publicKey = base64UrlDecode(keys.publicKey);
  if (publicKey.length !== 65 || publicKey[0] !== 4)
    throw new RangeError("VAPID_PUBLIC_KEY is not an uncompressed P-256 key.");
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: base64UrlEncode(publicKey.slice(1, 33)),
    y: base64UrlEncode(publicKey.slice(33, 65)),
    d: keys.privateKey,
    ext: true,
  };
  const signingKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const header = base64UrlEncode(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64UrlEncode(
    utf8(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: nowSeconds + 12 * 60 * 60,
        sub: keys.subject,
      }),
    ),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      signingKey,
      utf8(`${header}.${claims}`),
    ),
  );
  return `vapid t=${header}.${claims}.${base64UrlEncode(signature)}, k=${keys.publicKey}`;
}

// The client --------------------------------------------------------------------------------------------------------

export interface VapidClientOptions {
  readonly keys: VapidKeys;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Attempts per push, retrying rate limits, server errors and network failures with backoff. */
  readonly attempts?: number;
}

/** Web Push over fetch with VAPID: one request per browser. */
export function vapidWebPushClient(options: VapidClientOptions): WebPushClient {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => Date.now());
  const attempts = options.attempts ?? 3;
  return {
    name: "vapid",
    async send(device, payload, sendOptions) {
      let body: Uint8Array<ArrayBuffer>;
      let authorization: string;
      try {
        body = await encryptWebPush(utf8(JSON.stringify(payload)), device.p256dh, device.auth);
        authorization = await vapidAuthorization(
          device.endpoint,
          options.keys,
          Math.floor(now() / 1000),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          status: "error",
          error: error instanceof RangeError ? "MessageTooBig" : "EncryptionFailed",
          message,
        };
      }
      let lastError = "";
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          const response = await doFetch(device.endpoint, {
            method: "POST",
            headers: {
              Authorization: authorization,
              "Content-Encoding": "aes128gcm",
              "Content-Type": "application/octet-stream",
              TTL: String(sendOptions.ttl),
              Urgency: sendOptions.urgency,
            },
            body,
          });
          if (response.status >= 200 && response.status < 300) return { status: "ok" };
          const detail = `The push service answered ${response.status}: ${(await response.text()).slice(0, 300)}`;
          if (response.status === 404 || response.status === 410)
            return { status: "error", error: "DeviceNotRegistered", message: detail };
          if (response.status === 413)
            return { status: "error", error: "MessageTooBig", message: detail };
          lastError = detail;
          if (response.status !== 429 && response.status < 500)
            return { status: "error", error: "PushServiceRefused", message: detail };
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
        if (attempt < attempts) await sleep(500 * 2 ** (attempt - 1));
      }
      return { status: "error", error: "RequestFailed", message: lastError };
    },
  };
}

/** Records pushes instead of sending them: tests, local runs and every environment without VAPID keys. */
export class RecordingWebPushClient implements WebPushClient {
  readonly name = "record";
  readonly sent: {
    readonly device: WebPushDevice;
    readonly payload: WebPushPayload;
    readonly options: WebPushOptions;
  }[] = [];

  async send(
    device: WebPushDevice,
    payload: WebPushPayload,
    options: WebPushOptions,
  ): Promise<WebPushResult> {
    this.sent.push({ device, payload, options });
    return { status: "ok" };
  }
}

// Environment -----------------------------------------------------------------------------------------------------

export const webPushEnvSchema = z
  .object({
    XOS_WEB_PUSH_TRANSPORT: z.enum(["record", "vapid"]).default("record"),
    VAPID_PUBLIC_KEY: z
      .string()
      .regex(/^[A-Za-z0-9_-]{87}$/, "an uncompressed P-256 public key, base64url")
      .optional(),
    VAPID_PRIVATE_KEY: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/, "a P-256 private key, base64url")
      .optional(),
    VAPID_SUBJECT: z
      .string()
      .regex(/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/, "a mailto: or https: contact")
      .optional(),
  })
  .refine(
    (env) =>
      env.XOS_WEB_PUSH_TRANSPORT !== "vapid" ||
      (env.VAPID_PUBLIC_KEY !== undefined &&
        env.VAPID_PRIVATE_KEY !== undefined &&
        env.VAPID_SUBJECT !== undefined),
    {
      message:
        "XOS_WEB_PUSH_TRANSPORT=vapid needs VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT",
      path: ["VAPID_PUBLIC_KEY"],
    },
  );
export type WebPushEnv = z.output<typeof webPushEnvSchema>;

/** Parses the Web Push environment, naming each bad variable without echoing its value. */
export function readWebPushEnv(source: Readonly<Record<string, string | undefined>>): WebPushEnv {
  const parsed = webPushEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(
      `Invalid web push environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return parsed.data;
}

/** The client the environment asks for: VAPID with XOS_WEB_PUSH_TRANSPORT=vapid, recording otherwise. */
export function createWebPushClient(env: WebPushEnv, fetchImpl?: typeof fetch): WebPushClient {
  if (env.XOS_WEB_PUSH_TRANSPORT !== "vapid") return new RecordingWebPushClient();
  return vapidWebPushClient({
    keys: {
      publicKey: env.VAPID_PUBLIC_KEY ?? "",
      privateKey: env.VAPID_PRIVATE_KEY ?? "",
      subject: env.VAPID_SUBJECT ?? "",
    },
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  });
}
