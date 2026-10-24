import { z } from "zod";

/**
 * Server environment for Gateway, validated with Zod. `instrumentation.ts` reads it when the server
 * boots, so a missing or malformed variable stops the process with one message naming every problem
 * instead of failing on the first request. Nothing here reaches the browser: the Supabase session is
 * held in httpOnly cookies and every Supabase call runs on the server.
 * See apps/gateway/.env.example for the local values.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Supabase API origin, for example http://127.0.0.1:56021 on the shared local stack. */
  SUPABASE_URL: z.url({ protocol: /^https?$/ }),
  /** Supabase anon (publishable) key. Public by design; RLS guards every row. */
  SUPABASE_ANON_KEY: z.string().min(20),
  /** Public origin of Gateway on the platform domain, used for auth links and the CSRF check. */
  GATEWAY_SITE_URL: z.url({ protocol: /^https?$/ }),
  /**
   * Comma-separated hosts that serve the platform Gateway (Section 4.4.7). Any other host is an
   * org's custom Gateway domain and shows only that org, in its brand. Defaults to the host of
   * GATEWAY_SITE_URL.
   */
  GATEWAY_PLATFORM_HOSTS: z.string().optional(),
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
   * Public origin of the docs site (production: https://docs.ghxstship.tech), for the help center
   * link on the platform Gateway. Custom domains never show it, so an org's brand stays its own.
   */
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
});

export type Env = z.infer<typeof EnvSchema>;

export class EnvError extends Error {
  override readonly name = "EnvError";
}

/** Parses an environment record; throws one EnvError listing every invalid variable. */
export function parseEnv(source: Readonly<Record<string, string | undefined>>): Env {
  const result = EnvSchema.safeParse(source);
  if (result.success) return result.data;
  const problems = result.error.issues
    .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  throw new EnvError(
    `Gateway cannot start: the environment is invalid.\n${problems}\nCopy apps/gateway/.env.example to apps/gateway/.env.local and fill it in.`,
  );
}

/** The hosts that serve the platform Gateway, lowercased, without ports. */
export function platformHosts(config: Env): string[] {
  const listed = (config.GATEWAY_PLATFORM_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
  return listed.length > 0 ? listed : [new URL(config.GATEWAY_SITE_URL).hostname.toLowerCase()];
}

/**
 * The docs site origin for the help panel's help center links (RRR-119), or null when
 * DOCS_SITE_URL is unset. The panel adds the locale and the path.
 */
export function docsSiteUrl(config: Pick<Env, "DOCS_SITE_URL">): string | null {
  return config.DOCS_SITE_URL ? config.DOCS_SITE_URL.replace(/\/+$/, "") : null;
}

let cached: Env | undefined;

/** The validated environment; parsed once per process. */
export function env(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
