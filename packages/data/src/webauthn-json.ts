/**
 * WebAuthn ceremonies across the wire (Section 9: passkeys, and security keys as a second factor). Atlas and
 * Gateway keep the Supabase session in httpOnly cookies, so Supabase Auth is called from the server: the server
 * fetches the options, the browser runs `navigator.credentials.create` or `get`, and the server verifies the
 * credential. Both directions travel as JSON with binary fields in base64url (the WebAuthn Level 3 JSON forms).
 *
 * Safe in the browser and on the server: no Node, DOM library or Supabase imports. The relying party comes from
 * Supabase Auth's configuration inside the options, never from code here.
 */

export interface CredentialDescriptorJSON {
  readonly id: string;
  readonly type: "public-key";
  readonly transports?: readonly string[];
}

export interface CreationOptionsJSON {
  readonly rp: { readonly id?: string; readonly name: string };
  readonly user: { readonly id: string; readonly name: string; readonly displayName: string };
  readonly challenge: string;
  readonly pubKeyCredParams: readonly { readonly type: "public-key"; readonly alg: number }[];
  readonly timeout?: number;
  readonly excludeCredentials?: readonly CredentialDescriptorJSON[];
  readonly authenticatorSelection?: Readonly<Record<string, unknown>>;
  readonly attestation?: string;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export interface RequestOptionsJSON {
  readonly challenge: string;
  readonly timeout?: number;
  readonly rpId?: string;
  readonly allowCredentials?: readonly CredentialDescriptorJSON[];
  readonly userVerification?: string;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

/** A credential as JSON: `response` carries attestationObject (create) or authenticatorData and signature (get). */
export interface CredentialJSON {
  readonly id: string;
  readonly rawId: string;
  readonly type: "public-key";
  readonly response: Readonly<Record<string, unknown>>;
  readonly clientExtensionResults: Readonly<Record<string, unknown>>;
  readonly authenticatorAttachment?: string;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="));
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Any value with binary fields (ArrayBuffer or a typed array), as JSON with those fields in base64url. */
export function binaryToJson(value: unknown): unknown {
  if (value instanceof ArrayBuffer) return bytesToBase64Url(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) {
    return bytesToBase64Url(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (Array.isArray(value)) return value.map(binaryToJson);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, binaryToJson(v)]));
  }
  return value;
}

/*
 * The browser's WebAuthn objects, typed structurally so this module needs no DOM library: only the members the
 * ceremonies read.
 */
interface BinaryDescriptor {
  readonly id: Uint8Array<ArrayBuffer>;
  readonly type: "public-key";
  readonly transports?: string[];
}

export interface BrowserCredential {
  readonly id: string;
  readonly rawId: ArrayBuffer;
  readonly authenticatorAttachment?: string | null;
  readonly response: {
    readonly clientDataJSON: ArrayBuffer;
    readonly attestationObject?: ArrayBuffer;
    readonly authenticatorData?: ArrayBuffer;
    readonly signature?: ArrayBuffer;
    readonly userHandle?: ArrayBuffer | null;
    getTransports?(): string[];
  };
  getClientExtensionResults(): unknown;
  toJSON?(): unknown;
}

interface BrowserCredentials {
  create(options: { publicKey: unknown }): Promise<unknown>;
  get(options: { publicKey: unknown }): Promise<unknown>;
}

function descriptor(d: CredentialDescriptorJSON): BinaryDescriptor {
  return {
    id: base64UrlToBytes(d.id),
    type: d.type,
    ...(d.transports ? { transports: [...d.transports] } : {}),
  };
}

/** Creation options as `navigator.credentials.create` takes them: binary fields as bytes. */
export function creationOptionsFromJson(json: CreationOptionsJSON): Record<string, unknown> {
  return {
    ...json,
    challenge: base64UrlToBytes(json.challenge),
    user: { ...json.user, id: base64UrlToBytes(json.user.id) },
    pubKeyCredParams: json.pubKeyCredParams.map((p) => ({ ...p })),
    excludeCredentials: (json.excludeCredentials ?? []).map(descriptor),
  };
}

/** Request options as `navigator.credentials.get` takes them: binary fields as bytes. */
export function requestOptionsFromJson(json: RequestOptionsJSON): Record<string, unknown> {
  return {
    ...json,
    challenge: base64UrlToBytes(json.challenge),
    allowCredentials: (json.allowCredentials ?? []).map(descriptor),
  };
}

const b64 = (buffer: ArrayBuffer) => bytesToBase64Url(new Uint8Array(buffer));

/** A credential the browser returned, as JSON (its own toJSON when the browser has WebAuthn Level 3). */
export function credentialToJson(credential: BrowserCredential): CredentialJSON {
  if (typeof credential.toJSON === "function") return credential.toJSON() as CredentialJSON;
  const response = credential.response;
  const fields: Record<string, unknown> = { clientDataJSON: b64(response.clientDataJSON) };
  if (response.attestationObject) {
    fields["attestationObject"] = b64(response.attestationObject);
    const transports = response.getTransports?.();
    if (transports) fields["transports"] = transports;
  } else {
    if (response.authenticatorData) fields["authenticatorData"] = b64(response.authenticatorData);
    if (response.signature) fields["signature"] = b64(response.signature);
    if (response.userHandle) fields["userHandle"] = b64(response.userHandle);
  }
  return {
    id: credential.id,
    rawId: b64(credential.rawId),
    type: "public-key",
    response: fields,
    clientExtensionResults: (credential.getClientExtensionResults() ?? {}) as Record<
      string,
      unknown
    >,
    ...(credential.authenticatorAttachment
      ? { authenticatorAttachment: credential.authenticatorAttachment }
      : {}),
  };
}

/** Why a ceremony in the browser ended without a credential. */
export type CeremonyFailure = "unsupported" | "cancelled" | "failed";

export type CeremonyResult =
  | { readonly ok: true; readonly credential: CredentialJSON }
  | { readonly ok: false; readonly reason: CeremonyFailure };

function failure(error: unknown): CeremonyResult {
  const name = error instanceof Error ? error.name : "";
  // NotAllowedError covers a dismissed prompt and a timeout; AbortError a cancelled request.
  return {
    ok: false,
    reason: name === "NotAllowedError" || name === "AbortError" ? "cancelled" : "failed",
  };
}

function browserCredentials(): BrowserCredentials | null {
  const scope = globalThis as {
    PublicKeyCredential?: unknown;
    navigator?: { credentials?: BrowserCredentials };
  };
  return typeof scope.PublicKeyCredential === "function" && scope.navigator?.credentials
    ? scope.navigator.credentials
    : null;
}

/** Whether this browser can run WebAuthn ceremonies. */
export function webAuthnAvailable(): boolean {
  return browserCredentials() !== null;
}

async function ceremony(
  run: (credentials: BrowserCredentials) => Promise<unknown>,
): Promise<CeremonyResult> {
  const credentials = browserCredentials();
  if (credentials === null) return { ok: false, reason: "unsupported" };
  try {
    const credential = await run(credentials);
    if (credential === null || credential === undefined) return { ok: false, reason: "cancelled" };
    return { ok: true, credential: credentialToJson(credential as BrowserCredential) };
  } catch (error) {
    return failure(error);
  }
}

/** Browser only: registers a credential (a passkey, or a security key as a second factor). */
export function createCredential(options: CreationOptionsJSON): Promise<CeremonyResult> {
  return ceremony((c) => c.create({ publicKey: creationOptionsFromJson(options) }));
}

/** Browser only: signs a challenge with a credential the person already holds. */
export function getCredential(options: RequestOptionsJSON): Promise<CeremonyResult> {
  return ceremony((c) => c.get({ publicKey: requestOptionsFromJson(options) }));
}
