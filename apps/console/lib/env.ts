import { z } from "zod";

/**
 * Server environment for the operator console, validated with Zod. `instrumentation.ts` reads it when the server
 * boots, so a missing or malformed variable stops the process with one message naming every problem instead of
 * failing on the first request. Nothing here reaches the browser: the Supabase session lives in httpOnly cookies
 * and every Supabase call runs on the server with the operator's own session, never the service role.
 * See apps/console/.env.example for the local values.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Supabase API origin of the platform's one project (the same as Atlas and Gateway). */
  SUPABASE_URL: z.url({ protocol: /^https?$/ }),
  /** Supabase anon (publishable) key. Public by design; the console RPCs check the operator. */
  SUPABASE_ANON_KEY: z.string().min(20),
  /** Public origin of the console, used for the OAuth return address and the CSRF check. */
  CONSOLE_SITE_URL: z.url({ protocol: /^https?$/ }),
  /**
   * "false" hides the password form, so the platform team signs in with Google only (ADR 0046). Any other value,
   * or none, shows it for local development and the end-to-end journeys.
   */
  CONSOLE_PASSWORD_SIGN_IN: z.string().optional(),
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
    `The console cannot start: the environment is invalid.\n${problems}\nCopy apps/console/.env.example to apps/console/.env.local and fill it in.`,
  );
}

/** Whether the sign-in page offers the password form. */
export function passwordSignIn(config: Pick<Env, "CONSOLE_PASSWORD_SIGN_IN">): boolean {
  return config.CONSOLE_PASSWORD_SIGN_IN?.trim().toLowerCase() !== "false";
}

/** Whether the console is served over https, which turns on Secure cookies, HSTS and upgrades. */
export function secureSite(config: Pick<Env, "CONSOLE_SITE_URL">): boolean {
  return config.CONSOLE_SITE_URL.startsWith("https:");
}

let cached: Env | undefined;

/** The validated environment; parsed once per process. */
export function env(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
