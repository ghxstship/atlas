import type { PlanRegistry } from "@xos/schemas/plans";
import type { StripeClient } from "./env.ts";
import {
  extraSeatForLookupKey,
  extraSeatLookupKeyFor,
  lookupKeyFor,
  planForLookupKey,
  type BillingInterval,
} from "./plans.ts";

/** No active Stripe price carries the lookup key; the catalogue is never changed from here. */
export class PriceNotFoundError extends Error {
  readonly lookupKey: string;
  constructor(lookupKey: string) {
    super(`No active Stripe price has the lookup key ${lookupKey}`);
    this.name = "PriceNotFoundError";
    this.lookupKey = lookupKey;
  }
}

/** Most extra seats one subscription carries, matching app.subscriptions.extra_seats. */
export const MAX_EXTRA_SEATS = 10_000;

/** Most units of an add-on in one purchase, matching app.addon_purchases.quantity. */
export const MAX_ADDON_QUANTITY = 100;

function assertCount(value: number, min: number, max: number, what: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${what} must be a whole number from ${String(min)} to ${String(max)}`);
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
  /** Seats above the plan's allowance, bought as the quantity of its extra-seat price (ADR 0035). */
  readonly extraSeats?: number;
  /** Existing Stripe customer of the org, when it has one. */
  readonly customerId?: string;
  /** Billing contact for a first checkout. */
  readonly customerEmail?: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

function customerFields(request: {
  readonly customerId?: string;
  readonly customerEmail?: string;
}): { customer?: string; customer_email?: string } {
  if (request.customerId !== undefined) return { customer: request.customerId };
  if (request.customerEmail !== undefined) return { customer_email: request.customerEmail };
  return {};
}

/**
 * Starts Stripe Checkout for a self-serve plan, with extra seats when asked. The org id travels in the
 * session and subscription metadata, which is how the webhook ties the subscription back to the org.
 * Promotion codes are accepted, so the founding-customer code applies at checkout (ADR 0035). Stripe
 * Tax computes tax and collects VAT and GST ids (Section 16). A quoted plan (Enterprise) refuses.
 */
export async function createCheckoutSession(
  stripe: StripeClient,
  registry: PlanRegistry,
  request: CheckoutRequest,
): Promise<{ readonly sessionId: string; readonly url: string }> {
  const extraSeats = request.extraSeats ?? 0;
  assertCount(extraSeats, 0, MAX_EXTRA_SEATS, "Extra seats");
  const price = await resolvePriceId(
    stripe,
    lookupKeyFor(registry, request.planCode, request.interval),
  );
  const lineItems = [{ price, quantity: 1 }];
  if (extraSeats > 0) {
    const seatPrice = await resolvePriceId(
      stripe,
      extraSeatLookupKeyFor(registry, request.planCode, request.interval),
    );
    lineItems.push({ price: seatPrice, quantity: extraSeats });
  }
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: lineItems,
    client_reference_id: request.orgId,
    metadata: { org_id: request.orgId },
    subscription_data: { metadata: { org_id: request.orgId } },
    allow_promotion_codes: true,
    automatic_tax: { enabled: true },
    tax_id_collection: { enabled: true },
    success_url: request.successUrl,
    cancel_url: request.cancelUrl,
    ...customerFields(request),
  });
  if (session.url === null) throw new Error("Stripe returned a checkout session without a URL");
  return { sessionId: session.id, url: session.url };
}

export interface AddonCheckoutRequest {
  readonly orgId: string;
  /** The org's plan now; the add-on must list it. */
  readonly planCode: string;
  readonly addonCode: string;
  readonly quantity?: number;
  readonly customerId?: string;
  readonly customerEmail?: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

/**
 * Starts Stripe Checkout for a one-time add-on such as an Aurora request pack (ADR 0035). The org,
 * add-on and quantity travel in the session metadata; the webhook records the purchase once the
 * session completes and is paid.
 */
export async function createAddonCheckoutSession(
  stripe: StripeClient,
  registry: PlanRegistry,
  request: AddonCheckoutRequest,
): Promise<{ readonly sessionId: string; readonly url: string }> {
  const quantity = request.quantity ?? 1;
  assertCount(quantity, 1, MAX_ADDON_QUANTITY, "Quantity");
  const addon = registry.addons.find((a) => a.code === request.addonCode);
  if (addon === undefined) throw new Error(`Unknown add-on ${request.addonCode}`);
  if (!addon.plans.includes(request.planCode)) {
    throw new Error(`The ${request.planCode} plan cannot buy ${request.addonCode}`);
  }
  const price = await resolvePriceId(stripe, addon.priceLookupKey);
  const metadata = {
    org_id: request.orgId,
    addon_code: addon.code,
    quantity: String(quantity),
  };
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price, quantity }],
    client_reference_id: request.orgId,
    metadata,
    payment_intent_data: { metadata },
    automatic_tax: { enabled: true },
    tax_id_collection: { enabled: true },
    success_url: request.successUrl,
    cancel_url: request.cancelUrl,
    ...customerFields(request),
  });
  if (session.url === null) throw new Error("Stripe returned a checkout session without a URL");
  return { sessionId: session.id, url: session.url };
}

/**
 * Sets the extra seats of an existing subscription (ADR 0035): adds, changes or removes the item of
 * the plan's extra-seat price, prorated. The webhook then syncs the new quantity to the database, which
 * raises the seat limit. Returns the quantity Stripe now carries.
 */
export async function setExtraSeats(
  stripe: StripeClient,
  registry: PlanRegistry,
  subscriptionId: string,
  extraSeats: number,
): Promise<number> {
  assertCount(extraSeats, 0, MAX_EXTRA_SEATS, "Extra seats");
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const items = subscription.items.data;
  const planItem = items.find((i) => planForLookupKey(registry, i.price.lookup_key) !== null);
  const plan = planForLookupKey(registry, planItem?.price.lookup_key);
  if (plan === null) throw new Error(`Subscription ${subscriptionId} carries no plan price`);
  const seatItem = items.find((i) => extraSeatForLookupKey(registry, i.price.lookup_key) !== null);
  if (seatItem === undefined && extraSeats === 0) return 0;
  const itemUpdate =
    seatItem === undefined
      ? {
          price: await resolvePriceId(
            stripe,
            extraSeatLookupKeyFor(registry, plan.planCode, plan.interval),
          ),
          quantity: extraSeats,
        }
      : extraSeats === 0
        ? { id: seatItem.id, deleted: true }
        : { id: seatItem.id, quantity: extraSeats };
  await stripe.subscriptions.update(subscriptionId, {
    items: [itemUpdate],
    proration_behavior: "create_prorations",
  });
  return extraSeats;
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
