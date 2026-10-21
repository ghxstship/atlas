import { createHmac } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";
import { PASSWORD } from "./support";

/**
 * A79's journey helpers (local stack only). E2E_SUPABASE_URL, E2E_SUPABASE_ANON_KEY and
 * E2E_SUPABASE_SERVICE_KEY name the local stack; the keys are the local development keys `supabase status`
 * prints, never a hosted project's.
 *
 * `stepUp` gives the browser a session that passed a second factor, the way a person would: it signs the
 * user in through Supabase Auth, enrolls a TOTP factor, verifies a code computed here (RFC 6238), and copies
 * the resulting session cookies into the page's context. A77's step-up dialog does the same in the
 * interface once it lands.
 */

function stack(): { url: string; anon: string; service: string } {
  const url = process.env["E2E_SUPABASE_URL"];
  const anon = process.env["E2E_SUPABASE_ANON_KEY"];
  const service = process.env["E2E_SUPABASE_SERVICE_KEY"];
  if (!url || !anon || !service) {
    throw new Error("Set E2E_SUPABASE_URL, E2E_SUPABASE_ANON_KEY and E2E_SUPABASE_SERVICE_KEY.");
  }
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url))
    throw new Error("A79's journeys run against a local stack only.");
  return { url, anon, service };
}

/** The service-role client of the local stack, for the steps a person cannot take (a Stripe webhook). */
export function serviceClient(): SupabaseClient {
  const { url, service } = stack();
  return createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
}

function base32(secret: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.replace(/=+$/, "").toUpperCase()) {
    const value = alphabet.indexOf(ch);
    if (value < 0) throw new Error("The TOTP secret is not base32.");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8)
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** RFC 6238 TOTP: SHA-1, 30-second steps, 6 digits. */
export function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac("sha1", base32(secret)).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, "0");
}

/** TOTP factors enrolled during this run, by email, so a second step-up reuses the factor. */
const factors = new Map<string, { id: string; secret: string }>();

export async function stepUp(page: Page, email: string): Promise<void> {
  const { url, anon } = stack();
  const jar = new Map<string, string>();
  const client = createServerClient(url, anon, {
    cookieOptions: { name: "xos-auth", path: "/", sameSite: "lax", httpOnly: true, secure: false },
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll(list) {
        for (const { name, value } of list) {
          if (value) jar.set(name, value);
          else jar.delete(name);
        }
      },
    },
  });
  const signedIn = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (signedIn.error) throw new Error(`Sign-in for step-up failed: ${signedIn.error.message}`);
  let factor = factors.get(email);
  if (!factor) {
    const enrolled = await client.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: "Journey key",
    });
    if (enrolled.error) throw new Error(`TOTP enrollment failed: ${enrolled.error.message}`);
    factor = { id: enrolled.data.id, secret: enrolled.data.totp.secret };
    factors.set(email, factor);
  }
  const verified = await client.auth.mfa.challengeAndVerify({
    factorId: factor.id,
    code: totp(factor.secret),
  });
  if (verified.error) throw new Error(`TOTP verification failed: ${verified.error.message}`);
  const host = new URL(page.url().startsWith("http") ? page.url() : "http://127.0.0.1").hostname;
  await page.context().clearCookies({ name: /^xos-auth/ });
  await page.context().addCookies(
    [...jar].map(([name, value]) => ({
      name,
      value,
      domain: host,
      path: "/",
      httpOnly: true,
      sameSite: "Lax" as const,
      secure: false,
    })),
  );
}

/** The id of an org by slug, read with the service role. */
export async function orgIdOf(slug: string): Promise<string> {
  const { data, error } = await serviceClient()
    .schema("app")
    .from("organizations")
    .select("id")
    .eq("slug", slug)
    .single();
  if (error || !data) throw new Error(`No org ${slug}: ${error?.message ?? ""}`);
  return (data as { id: string }).id;
}

/**
 * What a Stripe webhook does when a payment fails (0560): links a Stripe subscription to the org on the Team
 * plan, then reports it past due. The ids are made up at run time and never reach Stripe.
 */
export async function failPayment(slug: string): Promise<void> {
  const org = await orgIdOf(slug);
  const app = serviceClient().schema("app");
  const suffix = Date.now().toString(36);
  const args = {
    p_org_id: org,
    p_stripe_customer_id: `cus_${["Journey", suffix].join("")}`,
    p_stripe_subscription_id: `sub_${["Journey", suffix].join("")}`,
    p_plan_code: "team",
    p_billing_interval: "Monthly",
    p_current_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    p_livemode: false,
  };
  for (const status of ["active", "past_due"]) {
    const { error } = await app.rpc("sync_subscription_from_stripe", {
      ...args,
      p_stripe_status: status,
    });
    if (error) throw new Error(`sync_subscription_from_stripe ${status}: ${error.message}`);
  }
}
