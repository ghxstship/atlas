// Supabase's publishable and secret API keys (ADR 0168). The platform gives every function SUPABASE_SECRET_KEYS and
// SUPABASE_PUBLISHABLE_KEYS, each a JSON object of key name to key (`default` is the first of each). The functions
// use only these: the legacy JWT-based `anon` and `service_role` keys are not read in production, so turning the
// legacy keys off in the dashboard breaks nothing.
//
// The local CLI stack (CLI 2.x) gives its functions only the legacy-named variables, holding its well-known
// development keys, so outside production a function falls back to SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY.
// XOS_ENVIRONMENT=production turns the fallback off.
//
// A worker (webhook-dispatch, notification-dispatch, upload-scan and the other scheduled functions) is called by
// pg_cron with a secret key from Vault (xos_worker_key) on the `apikey` header. The secret keys are not JWTs, so the
// platform's verify_jwt check cannot pass them; every worker runs with verify_jwt = false (supabase/config.toml) and
// compares the key itself, against every secret key the project has, so a key made only for the workers works and
// can be revoked on its own. packages/platform/test/api-keys.test.ts holds the rules.

export type EnvReader = (name: string) => string | undefined;

type Kind = "secret" | "publishable";

const KINDS: Record<Kind, { variable: string; prefix: string; local: string }> = {
  secret: {
    variable: "SUPABASE_SECRET_KEYS",
    prefix: "sb_secret_",
    local: "SUPABASE_SERVICE_ROLE_KEY",
  },
  publishable: {
    variable: "SUPABASE_PUBLISHABLE_KEYS",
    prefix: "sb_publishable_",
    local: "SUPABASE_ANON_KEY",
  },
};

/** The named keys in one of the platform's key variables; an unset or unreadable value has none. */
export function namedKeys(raw: string | undefined, prefix: string): ReadonlyMap<string, string> {
  if (raw === undefined || raw.trim() === "") return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Map();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return new Map();
  return new Map(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && entry[1].startsWith(prefix),
    ),
  );
}

function isProduction(read: EnvReader): boolean {
  return read("XOS_ENVIRONMENT")?.trim().toLowerCase() === "production";
}

/** Every key of a kind the project has: the new keys, or outside production the local stack's legacy-named one. */
export function apiKeys(kind: Kind, read: EnvReader): readonly string[] {
  const spec = KINDS[kind];
  const named = namedKeys(read(spec.variable), spec.prefix);
  if (named.size > 0) {
    const preferred = named.get("default");
    return preferred === undefined
      ? [...named.values()]
      : [preferred, ...[...named.values()].filter((key) => key !== preferred)];
  }
  if (isProduction(read)) return [];
  const local = read(spec.local);
  return local === undefined || local === "" ? [] : [local];
}

/** The key a function calls Supabase with: `default`, else the first; a thrown error names the missing variable. */
export function apiKey(kind: Kind, read: EnvReader): string {
  const [key] = apiKeys(kind, read);
  if (key === undefined) throw new Error(`${KINDS[kind].variable} is not set`);
  return key;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * True when the request carries one of the project's secret keys: on the `apikey` header (how pg_net sends it) or,
 * for a caller that sends the same key on both, as `Authorization: Bearer`. Only an exact key passes; no claim in a
 * token is trusted.
 */
export function carriesSecretKey(
  headers: { readonly apikey: string | null; readonly authorization: string | null },
  secretKeys: readonly string[],
): boolean {
  const bearer = headers.authorization?.startsWith("Bearer ")
    ? headers.authorization.slice(7)
    : null;
  const offered = [headers.apikey, bearer].filter(
    (value): value is string => value !== null && value.length > 0,
  );
  return secretKeys.some(
    (key) => key.length > 0 && offered.some((value) => constantTimeEqual(value, key)),
  );
}
