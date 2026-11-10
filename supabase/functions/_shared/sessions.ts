// Sessions without the platform's verify_jwt (ADR 0168, D5 and D6): a signed-in person's session checked with
// Supabase Auth, and the signer for the tokens XOS mints. Only the functions that need them import this file.
import { loadProjectTokens } from "../_vendor/core.js";
import { env, publishableKey } from "./runtime.ts";

/** The person a session belongs to, as Supabase Auth says (it verifies whatever key signed it), or null. */
export async function sessionUserId(authorization: string): Promise<string | null> {
  if (!authorization.startsWith("Bearer ") || authorization.length <= 7) return null;
  const response = await fetch(`${env("SUPABASE_URL")}/auth/v1/user`, {
    headers: { apikey: publishableKey(), Authorization: authorization },
  });
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  const user = (await response.json().catch(() => null)) as { id?: unknown } | null;
  return typeof user?.id === "string" && user.id !== "" ? user.id : null;
}

/** Signs one token's claims (packages/platform/src/jwt/project-token.ts). */
export type ProjectTokenSigner = (claims: Record<string, unknown>) => Promise<string>;

let signer: ProjectTokenSigner | null = null;

/** Signs minted tokens with XOS_API_JWT_SIGNING_KEY (a private JWK); its code loads with the first token. */
export function tokenSigner(): ProjectTokenSigner {
  const raw = env("XOS_API_JWT_SIGNING_KEY");
  const production = Deno.env.get("XOS_ENVIRONMENT")?.trim().toLowerCase() === "production";
  let loaded: Promise<ProjectTokenSigner> | null = null;
  signer ??= async (claims: Record<string, unknown>) => {
    loaded ??= loadProjectTokens().then(
      (m: {
        projectTokenSigner: (raw: string, o: { production: boolean }) => ProjectTokenSigner;
      }) => m.projectTokenSigner(raw, { production }),
    );
    return (await loaded)(claims);
  };
  return signer;
}
