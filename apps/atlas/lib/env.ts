import { z } from "zod";

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
    `Atlas cannot start: the environment is invalid.\n${problems}\nCopy apps/atlas/.env.example to apps/atlas/.env.local and fill it in.`,
  );
}

let cached: Env | undefined;

/** The validated environment; parsed once per process. */
export function env(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
