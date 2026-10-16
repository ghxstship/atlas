/**
 * Personal data redaction for logs, span attributes and error reports (Section 9, Section 14.3).
 *
 * Every value that leaves a process for a telemetry backend passes through `redact`. Two layers apply:
 *   1. Keys. A field whose name says it holds a credential or personal data is replaced whole,
 *      whatever its value looks like (`email`, `phone`, `authorization`, `tax_id`, `latitude`).
 *   2. Values. Strings are scanned for shapes that are personal data or credentials wherever they
 *      appear (an email inside an error message, a bearer token inside a URL).
 *
 * Pseudonymous identifiers (UUIDs for orgs, people, requests) are kept: incident response needs
 * them, and they reveal nothing without database access (proposed ADR, see infra/README.md).
 *
 * The module has no runtime dependencies and no Node built-ins, so Atlas, Gateway (Node and Edge
 * runtimes) and Supabase Edge Functions (Deno) import the same file.
 */

export const REDACTED = "[redacted]";

/** Normalized key names (lowercase letters and digits only) that are always replaced. */
const EXACT_KEYS = new Set([
  "ip",
  "pin",
  "dob",
  "ssn",
  "sin",
  "tin",
  "ein",
  "lat",
  "lng",
  "lon",
  "zip",
  "otp",
  "cvc",
  "cvv",
  "pan",
  "iban",
  "cookie",
  "cookies",
  "session",
  "notes",
  "street",
  "address",
  "latitude",
  "longitude",
  "geolocation",
  "location",
  "birthdate",
  "dateofbirth",
  "postalcode",
  "postcode",
  "zipcode",
  "passport",
  "diagnosis",
  "medical",
  "signature",
  "xforwardedfor",
  "xrealip",
  "forwarded",
  "remoteaddr",
  "useragent",
]);

/** Normalized key suffixes that are always replaced (`contact_email`, `x-api-key`, `refreshToken`). */
const KEY_SUFFIXES = [
  "password",
  "passwd",
  "passphrase",
  "secret",
  "token",
  "apikey",
  "authorization",
  "credential",
  "credentials",
  "privatekey",
  "setcookie",
  "sessionid",
  "recoverycode",
  "totp",
  "email",
  "emailaddress",
  "phone",
  "phonenumber",
  "mobile",
  "firstname",
  "lastname",
  "fullname",
  "givenname",
  "familyname",
  "displayname",
  "legalname",
  "personname",
  "middlename",
  "streetaddress",
  "addressline1",
  "addressline2",
  "taxid",
  "taxidentifier",
  "nationalid",
  "governmentid",
  "driverslicense",
  "bankaccount",
  "accountnumber",
  "routingnumber",
  "cardnumber",
  "ipaddress",
  "clientip",
  "remoteip",
  "freetext",
];

export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isSensitiveKey(key: string): boolean {
  const k = normalizeKey(key);
  if (k.length === 0) return false;
  if (EXACT_KEYS.has(k)) return true;
  return KEY_SUFFIXES.some((suffix) => k.endsWith(suffix));
}

interface ValuePattern {
  readonly pattern: RegExp;
  readonly replace: string | ((match: string, ...groups: string[]) => string);
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Ordered: credentials first, so a token that contains an email-like run is replaced whole. */
const VALUE_PATTERNS: readonly ValuePattern[] = [
  { pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/g, replace: "[jwt]" },
  {
    pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi,
    replace: (_m, scheme) => `${scheme} ${REDACTED}`,
  },
  { pattern: /\bxos_(?:live|test)_[A-Za-z0-9_]+/g, replace: "[api-key]" },
  { pattern: /\b(?:sk|rk|pk|whsec)_(?:live|test)_[A-Za-z0-9]+/g, replace: "[api-key]" },
  {
    pattern:
      /([?&;](?:token|access_token|refresh_token|id_token|code|key|apikey|api_key|signature|sig|password|email|phone|token_hash)=)[^&#\s"']+/gi,
    replace: (_m, prefix) => `${prefix}${REDACTED}`,
  },
  { pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, replace: "[email]" },
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replace: "[ssn]" },
  {
    pattern: /(?<![\w-])\d{4}(?:[ -]?\d{4}){2,3}(?:[ -]?\d{1,3})?(?![\w-])/g,
    replace: (match) => {
      const digits = match.replace(/[ -]/g, "");
      return digits.length >= 13 && digits.length <= 19 && luhnValid(digits) ? "[card]" : match;
    },
  },
  { pattern: /(?<![\w+])\+\d{8,15}\b/g, replace: "[phone]" },
  { pattern: /(?<![\w-])\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}(?![\w-])/g, replace: "[phone]" },
  {
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
    replace: "[ip]",
  },
  { pattern: /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, replace: "[ip]" },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RedactOptions {
  /** Keys kept even when their name looks sensitive, for fields a caller has already reduced. */
  readonly allowKeys?: readonly string[];
  /** Deepest level copied; deeper values are replaced with `[depth]`. */
  readonly maxDepth?: number;
  /** Longest string kept; longer strings are cut and marked. */
  readonly maxStringLength?: number;
}

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_STRING = 4096;

export function redactString(input: string, maxLength = DEFAULT_MAX_STRING): string {
  if (UUID.test(input)) return input;
  let out = input;
  for (const { pattern, replace } of VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    out =
      typeof replace === "string"
        ? out.replace(pattern, replace)
        : out.replace(pattern, replace as (substring: string, ...args: string[]) => string);
  }
  if (out.length > maxLength)
    out = `${out.slice(0, maxLength)}[truncated ${out.length - maxLength}]`;
  return out;
}

/** Removes the query string and fragment from a URL or path, keeping only the path. */
export function redactUrl(input: string): string {
  const cut = input.search(/[?#]/);
  return redactString(cut === -1 ? input : input.slice(0, cut));
}

/**
 * Returns a deep copy of `value` with personal data and credentials replaced. Never throws and
 * never mutates its input. Cycles become `[circular]`.
 */
export function redact(value: unknown, options: RedactOptions = {}): unknown {
  const allow = new Set((options.allowKeys ?? []).map(normalizeKey));
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxString = options.maxStringLength ?? DEFAULT_MAX_STRING;
  const seen = new WeakSet<object>();

  const walk = (v: unknown, depth: number): unknown => {
    if (v === null || v === undefined) return v;
    switch (typeof v) {
      case "string":
        return redactString(v, maxString);
      case "number":
      case "boolean":
        return v;
      case "bigint":
        return v.toString();
      case "symbol":
        return v.toString();
      case "function":
        return undefined;
      default:
        break;
    }
    const obj = v as object;
    if (depth >= maxDepth) return "[depth]";
    if (seen.has(obj)) return "[circular]";
    seen.add(obj);
    try {
      if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? null : obj.toISOString();
      if (obj instanceof Error) return redactError(obj, walk, depth);
      if (obj instanceof URL) return redactUrl(obj.toString());
      if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) {
        return `[binary ${(obj as ArrayBuffer).byteLength} bytes]`;
      }
      if (obj instanceof Map) {
        return walk(Object.fromEntries(obj), depth);
      }
      if (obj instanceof Set) return walk([...obj], depth);
      if (Array.isArray(obj)) return obj.map((item) => walk(item, depth + 1));
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(obj)) {
        if (!allow.has(normalizeKey(key)) && isSensitiveKey(key)) {
          out[key] = child === null || child === undefined ? child : REDACTED;
          continue;
        }
        const copied = walk(child, depth + 1);
        if (copied !== undefined) out[key] = copied;
      }
      return out;
    } finally {
      seen.delete(obj);
    }
  };

  return walk(value, 0);
}

function redactError(
  error: Error,
  walk: (v: unknown, depth: number) => unknown,
  depth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: error.name,
    message: redactString(error.message),
  };
  if (error.stack) out["stack"] = redactString(error.stack, 8192);
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") out["code"] = code;
  if (error.cause !== undefined) out["cause"] = walk(error.cause, depth + 1);
  return out;
}

/** Span and metric attribute values: primitives and arrays of primitives only. */
export type AttributeValue =
  string | number | boolean | readonly string[] | readonly number[] | readonly boolean[];

/** Redacts a flat attribute map for OpenTelemetry spans, dropping values that are not attributes. */
export function redactAttributes(
  attributes: Readonly<Record<string, unknown>>,
  options: RedactOptions = {},
): Record<string, AttributeValue> {
  const allow = new Set((options.allowKeys ?? []).map(normalizeKey));
  const out: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined) continue;
    if (!allow.has(normalizeKey(key)) && isSensitiveKey(key)) {
      out[key] = REDACTED;
      continue;
    }
    if (typeof value === "string") out[key] = redactString(value, 1024);
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      out[key] = value.map((item: string) => redactString(item, 1024));
    } else if (Array.isArray(value) && value.every((item) => typeof item === "number")) {
      out[key] = value as number[];
    } else if (Array.isArray(value) && value.every((item) => typeof item === "boolean")) {
      out[key] = value as boolean[];
    }
  }
  return out;
}
