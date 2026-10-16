import { createHash } from "node:crypto";
import { IntegrationError } from "./errors.ts";

/**
 * A credential as read from Vault. OAuth connectors store JSON (`{"access_token": ..., "realm_id": ...}`);
 * key-based connectors store the key alone. Extra string fields (tenant, realm, account ids) stay
 * available to the connector by name.
 */
export interface Credential {
  readonly token: string;
  readonly fields: Readonly<Record<string, string>>;
}

export function parseCredential(secret: string | null): Credential {
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
  const token = fields["access_token"] ?? fields["api_key"] ?? fields["token"];
  if (token === undefined) {
    throw new IntegrationError(
      "credential_malformed",
      "The stored credential has no access token or key.",
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
