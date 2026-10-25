import { createHash } from "node:crypto";
import { usesClientCredentials } from "./catalog.ts";
import { IntegrationError } from "./errors.ts";

/**
 * A credential as read from Vault. OAuth connectors store JSON (`{"access_token": ..., "realm_id": ...}`);
 * key-based connectors store the key alone. Extra string fields (tenant, realm, account ids) stay
 * available to the connector by name. A client-credentials pair (`{"client_id": ..., "client_secret": ...}`,
 * UPS and FedEx) has no token of its own: `token` is empty and the connector mints one from the fields.
 */
export interface Credential {
  readonly token: string;
  readonly fields: Readonly<Record<string, string>>;
}

/**
 * The stored form of a client-credentials pair, as Atlas's credential form saves it and `parseCredential` and the
 * UPS and FedEx connectors read it back.
 */
export function clientCredentialSecret(clientId: string, clientSecret: string): string {
  return JSON.stringify({ client_id: clientId, client_secret: clientSecret });
}

/**
 * Reads a stored credential. `providerCode` names the connection's provider: only a provider that mints its own
 * tokens (`usesClientCredentials`) may store a client ID and secret without a token, so an OAuth or key-based
 * provider given such a pair fails here as malformed, not later with an empty bearer token.
 */
export function parseCredential(secret: string | null, providerCode?: string): Credential {
  if (secret === null || secret.length === 0) {
    throw new IntegrationError("credential_required", "The connection has no stored credential.", {
      connectionError: true,
    });
  }
  const trimmed = secret.trim();
  if (!trimmed.startsWith("{")) return { token: trimmed, fields: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new IntegrationError(
      "credential_malformed",
      `The stored credential is not valid JSON: ${String(error)}`,
      {
        connectionError: true,
      },
    );
  }
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string") fields[key] = value;
  }
  const mintsTokens = providerCode !== undefined && usesClientCredentials(providerCode);
  const clientPair = fields["client_id"] !== undefined && fields["client_secret"] !== undefined;
  const token =
    fields["access_token"] ??
    fields["api_key"] ??
    fields["token"] ??
    (mintsTokens && clientPair ? "" : undefined);
  if (token === undefined) {
    throw new IntegrationError(
      "credential_malformed",
      mintsTokens
        ? "The stored credential has no client ID and secret."
        : "The stored credential has no access token or key.",
      {
        connectionError: true,
      },
    );
  }
  return { token, fields };
}

/** Reads a required credential field, failing the connection when it is missing. */
export function credentialField(credential: Credential, name: string): string {
  const value = credential.fields[name];
  if (value === undefined || value.length === 0) {
    throw new IntegrationError(
      "credential_incomplete",
      `The stored credential is missing ${name}.`,
      {
        connectionError: true,
      },
    );
  }
  return value;
}

/** Delay before retry attempt n, mirroring `private.integration_backoff`: 30 s doubled per attempt, capped at 1 h. */
export function integrationBackoffMs(attempt: number): number {
  return Math.min(3_600_000, 30_000 * 2 ** (Math.max(attempt, 1) - 1));
}

/** Stable SHA-256 of a JSON value with sorted keys, lowercase hex, for `integration_external_ids.content_hash`. */
export function contentHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

/** Formats integer minor units as a decimal string with the currency's exponent (no floating point). */
export function minorToDecimal(minor: bigint | number, exponent: number): string {
  const value = BigInt(minor);
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(exponent + 1, "0");
  const whole = exponent === 0 ? digits : digits.slice(0, -exponent);
  const fraction = exponent === 0 ? "" : `.${digits.slice(-exponent)}`;
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

/** Parses a decimal amount into integer minor units; refuses more precision than the currency has. */
export function decimalToMinor(amount: string | number, exponent: number): bigint {
  const text = typeof amount === "number" ? amount.toFixed(exponent) : amount.trim();
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text);
  if (match === null)
    throw new IntegrationError("amount_malformed", `${text} is not a decimal amount.`);
  const fraction = (match[3] ?? "").replace(/0+$/, "");
  if (fraction.length > exponent) {
    throw new IntegrationError(
      "amount_precision",
      `${text} has more decimal places than the currency allows.`,
    );
  }
  const minor = BigInt((match[2] ?? "0") + fraction.padEnd(exponent, "0"));
  return match[1] === "-" ? -minor : minor;
}
