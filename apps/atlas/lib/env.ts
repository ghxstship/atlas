import { z } from "zod";

/** A host name with at least one dot, lowercase, without a scheme or port. */
const HOST_NAME =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Server environment for Atlas, validated with Zod. `instrumentation.ts` reads it when the server
 * boots, so a missing or malformed variable stops the process with one message naming every problem
 * instead of failing on the first request. Nothing here reaches the browser: the Supabase session is
 * held in httpOnly cookies and every Supabase call runs on the server.
 * See apps/atlas/.env.example for the local values (the 554xx stack in supabase/config.toml).
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Supabase API origin, for example http://127.0.0.1:55421 locally. */
  SUPABASE_URL: z.url({ protocol: /^https?$/ }),
  /** Supabase anon (publishable) key. Public by design; RLS guards every row. */
  SUPABASE_ANON_KEY: z.string().min(20),
  /** Public origin of Atlas, used for auth redirect links and the CSRF origin check. */
  ATLAS_SITE_URL: z.url({ protocol: /^https?$/ }),
  /** Public origin of Gateway, for the advance and signing links Atlas issues (Section 4.4.6). */
  GATEWAY_SITE_URL: z.url({ protocol: /^https?$/ }).optional(),
  /** Supabase Auth email testing inbox (Inbucket or Mailpit), development and e2e only. */
  SUPABASE_INBUCKET_URL: z.url().optional(),
  /**
   * Universal links for Continue on another device (ADR 0030): comma-separated Apple Developer team
   * ids and Android signing certificate SHA-256 fingerprints of Compass. Unset, the
   * apple-app-site-association and assetlinks.json files answer 404 and QR codes carry compass:// links.
   */
  COMPASS_APPLE_TEAM_IDS: z.string().optional(),
  COMPASS_ANDROID_CERT_SHA256: z.string().optional(),
  /**
   * WebAuthn relying party for security keys as a second factor (Section 9), the same values as Supabase
   * Auth's [auth.webauthn] rp_id and rp_origins: the registrable domain, and the https origins of Atlas and
   * Gateway, comma-separated. Unset, people add authenticator apps and passkeys but not security keys.
   */
  WEBAUTHN_RP_ID: z
    .string()
    .regex(/^[a-z0-9.-]+$/)
    .optional(),
  WEBAUTHN_RP_ORIGINS: z.string().optional(),
  /**
   * Trusted proxies in front of the one that appends the client address to X-Forwarded-For
   * (A69-003). Unset (0) on Vercel and behind one proxy; 1 behind a CDN and a proxy, and so on.
   */
  XOS_TRUSTED_PROXY_HOPS: z
    .string()
    .regex(/^\d{1,2}$/)
    .optional(),
  /**
   * The API host (RRR-119), a host name such as api.ghxstship.tech. On that host Atlas serves only
   * the public API: `/v1/...` is the API at `/api/v1/...`, `/` answers a JSON pointer to the
   * OpenAPI document and the docs, and every other path answers 404. No page, session refresh or
   * cookie is served there (lib/api-host.ts). Unset, Atlas serves the API at `/api/v1` only.
   */
  XOS_API_HOST: z
    .string()
    .trim()
    .toLowerCase()
    .regex(HOST_NAME, "Use a host name such as api.example.com, without https:// or a port.")
    .optional(),
  /** Public origin of the docs site, for help center and API reference links. Unset, none show. */
  DOCS_SITE_URL: z.url({ protocol: /^https?$/ }).optional(),
  /**
   * The VAPID public key browsers subscribe to Web Push with (A96, ADR 0052), the same value as the
   * notification-dispatch Edge Function's VAPID_PUBLIC_KEY: an uncompressed P-256 key, base64url. Public by
   * design. Unset, the browser notifications setting says they are not set up yet.
   */
  VAPID_PUBLIC_KEY: z
    .string()
    .regex(/^[A-Za-z0-9_-]{87}$/, "Use the 87-character base64url VAPID public key.")
    .optional(),
  /**
   * The domain project inbox mail is received on (Section 4.6.5, ADR 0040), the same value the
   * inbound-email Edge Function reads. Unset, Atlas shows each inbox's local part and says the
   * receiving domain is not set up yet.
   */
  XOS_INBOUND_DOMAIN: z
    .string()
    .trim()
    .toLowerCase()
    .regex(HOST_NAME, "Use a domain such as inbound.example.com, without @ or a scheme.")
    .optional(),
  /**
   * The Data API origin of a Supabase read replica (Section 5.1, A65-032). Set, the full org export reads
   * there as the signed-in Owner and falls back to the primary; unset, every read stays on the primary.
   * The report-run Edge Function reads the same variable for scheduled report runs.
   */
  XOS_READ_REPLICA_URL: z.url({ protocol: /^https?$/ }).optional(),
});

export type Env = z.infer<typeof EnvSchema>;

/** The API host must not be the Atlas host, or every Atlas page would answer as the API. */
function checkApiHost(config: Env): string | null {
  if (config.XOS_API_HOST === undefined) return null;
  return config.XOS_API_HOST === new URL(config.ATLAS_SITE_URL).hostname.toLowerCase()
    ? "  XOS_API_HOST: must differ from the host of ATLAS_SITE_URL."
    : null;
}

export class EnvError extends Error {
  override readonly name = "EnvError";
}

/** Parses an environment record; throws one EnvError listing every invalid variable. */
export function parseEnv(source: Readonly<Record<string, string | undefined>>): Env {
  const result = EnvSchema.safeParse(source);
  const conflict = result.success ? checkApiHost(result.data) : null;
  if (result.success && conflict === null) return result.data;
  const problems = result.success
    ? conflict
    : result.error.issues
        .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("\n");
  throw new EnvError(
    `Atlas cannot start: the environment is invalid.\n${problems}\nCopy apps/atlas/.env.example to apps/atlas/.env.local and fill it in.`,
  );
}

let cached: Env | undefined;

/** The validated environment; parsed once per process. */
export function env(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
