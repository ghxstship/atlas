import type { PlanRegistry } from "@xos/schemas/plans";
import type { StripeClient } from "./env.ts";
import { lookupKeyFor, type BillingInterval } from "./plans.ts";

/** No active Stripe price carries the lookup key; the catalogue is never changed from here. */
export class PriceNotFoundError extends Error {
  readonly lookupKey: string;
  constructor(lookupKey: string) {
    super(`No active Stripe price has the lookup key ${lookupKey}`);
    this.name = "PriceNotFoundError";
    this.lookupKey = lookupKey;
  }
}

/**
 * Resolves a price by lookup key at runtime (ADR 0018), so the same code works in test and live mode.
 * Never creates, edits or archives products or prices.
 */
export async function resolvePriceId(stripe: StripeClient, lookupKey: string): Promise<string> {
  const prices = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  const price = prices.data[0];
  if (price === undefined) throw new PriceNotFoundError(lookupKey);
  return price.id;
}

export interface CheckoutRequest {
  readonly orgId: string;
  readonly planCode: string;
  readonly interval: BillingInterval;
  /** Existing Stripe customer of the org, when it has one. */
  readonly customerId?: string;
  /** Billing contact for a first checkout. */
  readonly customerEmail?: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

/**
 * Starts Stripe Checkout for a paid plan. The org id travels in the session and subscription metadata,
 * which is how the webhook ties the subscription back to the org. Stripe Tax computes tax and collects
 * VAT and GST ids (Section 16).
 */
export async function createCheckoutSession(
  stripe: StripeClient,
  registry: PlanRegistry,
  request: CheckoutRequest,
): Promise<{ readonly sessionId: string; readonly url: string }> {
  const price = await resolvePriceId(
    stripe,
    lookupKeyFor(registry, request.planCode, request.interval),
  );
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    client_reference_id: request.orgId,
    metadata: { org_id: request.orgId },
    subscription_data: { metadata: { org_id: request.orgId } },
    automatic_tax: { enabled: true },
    tax_id_collection: { enabled: true },
    success_url: request.successUrl,
    cancel_url: request.cancelUrl,
    ...(request.customerId !== undefined
      ? { customer: request.customerId }
      : request.customerEmail !== undefined
        ? { customer_email: request.customerEmail }
        : {}),
  });
  if (session.url === null) throw new Error("Stripe returned a checkout session without a URL");
  return { sessionId: session.id, url: session.url };
}

/** Opens the Stripe Customer Portal for an org's customer (Section 5: Stripe Customer Portal). */
export async function createPortalSession(
  stripe: StripeClient,
  customerId: string,
  returnUrl: string,
): Promise<string> {
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return session.url;
}
