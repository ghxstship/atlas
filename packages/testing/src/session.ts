import type { AuthSession } from "./lighthouse.ts";

/**
 * A demo person's session from the local stack's password grant, for the browser checks that
 * visit signed-in pages (lighthouse-cli.ts, served-budget-cli.ts). Environment: SUPABASE_URL and
 * SUPABASE_ANON_KEY name the local stack; LH_PASSWORD overrides the seed's shared demo password.
 */
export async function signIn(email: string): Promise<AuthSession> {
  const supabaseUrl = process.env["SUPABASE_URL"] ?? "http://127.0.0.1:57421";
  const anonKey = process.env["SUPABASE_ANON_KEY"] ?? "";
  if (!anonKey) throw new Error("SUPABASE_ANON_KEY is required for signed-in pages.");
  const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: process.env["LH_PASSWORD"] ?? "xos-demo-2026" }),
  });
  if (!res.ok) throw new Error(`Sign-in for ${email} answered ${res.status}: ${await res.text()}`);
  return (await res.json()) as AuthSession;
}
