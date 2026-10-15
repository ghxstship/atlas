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

let cached: Env | undefined;

/** The validated environment; parsed once per process. */
export function env(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
