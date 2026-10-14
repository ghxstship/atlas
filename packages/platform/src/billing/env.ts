import Stripe from "stripe";
import { z } from "zod";

/**
 * Billing environment, validated at start-up. The Stripe keys belong to the owner's Stripe account
 * and arrive through encrypted environment variables (Section 9); without them every Stripe call
 * refuses with BillingNotConfiguredError instead of failing halfway.
 */
export const billingEnvSchema = z.object({
  STRIPE_SECRET_KEY: z
    .string()
    .regex(
      /^(sk|rk)_(test|live)_[A-Za-z0-9]{8,}$/,
      "STRIPE_SECRET_KEY must be a Stripe secret or restricted key",
    )
    .optional(),
  STRIPE_WEBHOOK_SECRET: z
    .string()
    .regex(
      /^whsec_[A-Za-z0-9]{8,}$/,
      "STRIPE_WEBHOOK_SECRET must be a Stripe webhook signing secret",
    )
    .optional(),
  XOS_APP_URL: z.url().default("http://127.0.0.1:3000"),
});

export type BillingEnv = z.output<typeof billingEnvSchema>;

/** Parses the billing environment, naming each bad variable. */
export function readBillingEnv(source: Readonly<Record<string, string | undefined>>): BillingEnv {
  const parsed = billingEnvSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid billing environment: ${problems}`);
  }
  return parsed.data;
}

/** Stripe is not configured in this environment (no key yet). */
export class BillingNotConfiguredError extends Error {
  constructor(variable: string) {
    super(`${variable} is not set; billing is not configured in this environment`);
    this.name = "BillingNotConfiguredError";
  }
}

/** True for test mode keys, so events from the other mode are never applied. */
export function isTestKey(key: string): boolean {
  return /^(sk|rk)_test_/.test(key);
}

/** The Stripe operations the platform uses. Tests pass fakes; production passes the SDK client. */
export interface StripeClient {
  readonly prices: Pick<Stripe["prices"], "list">;
  readonly checkout: { readonly sessions: Pick<Stripe["checkout"]["sessions"], "create"> };
  readonly billingPortal: {
    readonly sessions: Pick<Stripe["billingPortal"]["sessions"], "create">;
  };
}

/**
 * Creates the Stripe client from the environment, using the fetch HTTP client so the same code runs
 * in Node and in the Deno Edge runtime.
 */
export function createStripeClient(
  env: BillingEnv,
  make: (key: string) => StripeClient = (key) =>
    new Stripe(key, { httpClient: Stripe.createFetchHttpClient(), maxNetworkRetries: 2 }),
): StripeClient {
  if (env.STRIPE_SECRET_KEY === undefined) throw new BillingNotConfiguredError("STRIPE_SECRET_KEY");
  return make(env.STRIPE_SECRET_KEY);
}
