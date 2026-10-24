import type Stripe from "stripe";
import { z } from "zod";
import { isTestKey } from "./keys.ts";

/** A loopback origin: a fake Stripe API on this machine, never a remote host. */
const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/;

/**
 * Billing environment, validated at start-up. The Stripe keys belong to the owner's Stripe account
 * and arrive through encrypted environment variables (Section 9); without them every Stripe call
 * refuses with BillingNotConfiguredError instead of failing halfway, and Atlas says billing is not
 * open yet (ADR 0033 decision 59).
 */
export const billingEnvSchema = z
  .object({
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
    /**
     * A local fake of the Stripe API for end-to-end journeys, such as http://127.0.0.1:12111. Only a
     * loopback origin and only with a test mode key, so no deployment can send billing anywhere else.
     */
    STRIPE_API_URL: z
      .string()
      .regex(
        LOOPBACK_ORIGIN,
        "STRIPE_API_URL must be a loopback origin such as http://127.0.0.1:12111",
      )
      .optional(),
    XOS_APP_URL: z.url().default("http://127.0.0.1:3000"),
  })
  .superRefine((env, ctx) => {
    if (env.STRIPE_API_URL === undefined) return;
    if (env.STRIPE_SECRET_KEY === undefined || !isTestKey(env.STRIPE_SECRET_KEY)) {
      ctx.addIssue({
        code: "custom",
        path: ["STRIPE_API_URL"],
        message: "STRIPE_API_URL works only with a test mode STRIPE_SECRET_KEY",
      });
    }
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

export { isTestKey } from "./keys.ts";

/** True when the environment has a Stripe key, so Checkout and the customer portal can open. */
export function billingConfigured(env: BillingEnv): boolean {
  return env.STRIPE_SECRET_KEY !== undefined;
}

/** True for a live mode key; the mode every Stripe id the database stores is checked against. */
export function billingLivemode(env: BillingEnv): boolean {
  return env.STRIPE_SECRET_KEY !== undefined && !isTestKey(env.STRIPE_SECRET_KEY);
}

/** The Stripe operations the platform uses. Tests pass fakes; production passes the SDK client. */
export interface StripeClient {
  readonly prices: Pick<Stripe["prices"], "list">;
  readonly checkout: {
    readonly sessions: Pick<Stripe["checkout"]["sessions"], "create" | "retrieve" | "expire">;
  };
  readonly billingPortal: {
    readonly sessions: Pick<Stripe["billingPortal"]["sessions"], "create">;
    readonly configurations: Pick<Stripe["billingPortal"]["configurations"], "list">;
  };
  readonly subscriptions: Pick<Stripe["subscriptions"], "retrieve" | "update">;
}

/** Where the SDK sends requests: Stripe itself, or the loopback fake of STRIPE_API_URL. */
export function stripeHost(
  env: BillingEnv,
): { host: string; port: string; protocol: "http" } | Record<string, never> {
  if (env.STRIPE_API_URL === undefined) return {};
  const url = new URL(env.STRIPE_API_URL);
  return { host: url.hostname, port: url.port, protocol: "http" };
}

/**
 * Creates the Stripe client from the environment, using the fetch HTTP client so the same code runs
 * in Node and in the Deno Edge runtime. The SDK loads only here, when a request needs Stripe, so a
 * page that merely shows billing never parses it.
 */
export async function createStripeClient(
  env: BillingEnv,
  make?: (key: string) => StripeClient,
): Promise<StripeClient> {
  if (env.STRIPE_SECRET_KEY === undefined) throw new BillingNotConfiguredError("STRIPE_SECRET_KEY");
  if (make !== undefined) return make(env.STRIPE_SECRET_KEY);
  const { default: StripeSdk } = await import("stripe");
  return new StripeSdk(env.STRIPE_SECRET_KEY, {
    httpClient: StripeSdk.createFetchHttpClient(),
    maxNetworkRetries: 2,
    ...stripeHost(env),
  });
}
