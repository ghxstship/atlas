import Stripe from "stripe";
import type { PlanRegistry } from "@xos/schemas/plans";
import { extraSeatForLookupKey, planForLookupKey, type BillingInterval } from "./plans.ts";

/** What the webhook handler needs from the database (implemented over the 0560 and 1250 RPCs). */
export interface BillingStore {
  recordStripeEvent(event: {
    readonly id: string;
    readonly type: string;
    readonly livemode: boolean;
    readonly createdAt: Date;
    readonly payload: unknown;
    readonly orgId: string | null;
  }): Promise<{ readonly rowId: string; readonly isNew: boolean; readonly processed: boolean }>;
  finishStripeEvent(rowId: string, error: string | null): Promise<void>;
  orgForCustomer(customerId: string): Promise<string | null>;
  syncSubscription(input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly subscriptionId: string;
    readonly planCode: string;
    readonly interval: BillingInterval;
    readonly status: string;
    readonly currentPeriodEnd: Date | null;
    readonly livemode: boolean;
    /** Quantity of the plan's extra-seat price; 0 without one (ADR 0034). */
    readonly extraSeats: number;
  }): Promise<string>;
  recordAddonPurchase(input: {
    readonly orgId: string;
    readonly addonCode: string;
    readonly quantity: number;
    readonly checkoutSessionId: string;
    readonly currency: string;
    readonly amountTotalMinor: number;
    readonly livemode: boolean;
    readonly paidAt: Date;
  }): Promise<string>;
}

export type WebhookOutcome =
  | { readonly outcome: "applied"; readonly eventId: string; readonly state: string }
  | { readonly outcome: "duplicate"; readonly eventId: string }
  | { readonly outcome: "ignored"; readonly eventId: string; readonly reason: string }
  | { readonly outcome: "failed"; readonly eventId: string; readonly error: string };

export interface StripeWebhookRequest {
  readonly rawBody: string;
  readonly signature: string | null;
  readonly webhookSecret: string;
  /** Mode of the configured key: events of the other mode are stored but never applied. */
  readonly livemode: boolean;
  readonly registry: PlanRegistry;
  readonly store: BillingStore;
  /** Clock for signature tolerance; Stripe's own when omitted. */
  readonly receivedAt?: number;
}

/** The Stripe signature header is missing or does not verify. */
export class StripeSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeSignatureError";
  }
}

const SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
]);

/** Checkout events that can complete a one-time add-on payment. */
const PAYMENT_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
]);

function customerIdOf(customer: string | { readonly id: string } | null): string | null {
  if (customer === null) return null;
  return typeof customer === "string" ? customer : customer.id;
}

/** The plan, term and extra seats a subscription's items carry, or why it is not a plan subscription. */
function readSubscriptionItems(
  registry: PlanRegistry,
  subscription: Stripe.Subscription,
):
  | {
      readonly planCode: string;
      readonly interval: BillingInterval;
      readonly extraSeats: number;
      readonly periodEnd: number | null;
    }
  | { readonly ignore: string } {
  const items = subscription.items.data;
  const planItem = items.find((i) => planForLookupKey(registry, i.price.lookup_key) !== null);
  const match = planForLookupKey(registry, planItem?.price.lookup_key);
  if (planItem === undefined || match === null) {
    return { ignore: "The subscription's price is not a plan price" };
  }
  let extraSeats = 0;
  for (const item of items) {
    const seat = extraSeatForLookupKey(registry, item.price.lookup_key);
    if (seat === null) continue;
    if (seat.planCode !== match.planCode || seat.interval !== match.interval) {
      return { ignore: "The subscription's extra-seat price belongs to another plan or term" };
    }
    extraSeats += item.quantity ?? 0;
  }
  return { ...match, extraSeats, periodEnd: planItem.current_period_end || null };
}

/**
 * Verifies a Stripe webhook with the SubtleCrypto provider (works in Node and Deno, needs no API key),
 * stores the event once (idempotent ingestion), and applies:
 *   - subscription events through app.sync_subscription_from_stripe, with the plan from the plan
 *     price's lookup key and the extra seats from the quantity of the plan's extra-seat price
 *   - completed, paid Checkout sessions for a one-time add-on through
 *     app.record_addon_purchase_from_stripe (ADR 0034)
 * A redelivered event that was applied is a duplicate; one that failed is applied again.
 */
export async function handleStripeWebhook(request: StripeWebhookRequest): Promise<WebhookOutcome> {
  if (request.signature === null || request.signature.length === 0) {
    throw new StripeSignatureError("Missing Stripe-Signature header");
  }
  let event: Stripe.Event;
  try {
    event = await Stripe.webhooks.constructEventAsync(
      request.rawBody,
      request.signature,
      request.webhookSecret,
      undefined,
      Stripe.createSubtleCryptoProvider(),
      request.receivedAt,
    );
  } catch (error) {
    throw new StripeSignatureError(error instanceof Error ? error.message : String(error));
  }

  const subscription = SUBSCRIPTION_EVENTS.has(event.type)
    ? (event.data.object as Stripe.Subscription)
    : null;
  const session = PAYMENT_EVENTS.has(event.type)
    ? (event.data.object as Stripe.Checkout.Session)
    : null;
  const customerId =
    subscription !== null
      ? customerIdOf(subscription.customer)
      : session !== null
        ? customerIdOf(session.customer)
        : null;
  const metadataOrg = (subscription ?? session)?.metadata?.["org_id"] ?? null;
  const orgId =
    metadataOrg ?? (customerId === null ? null : await request.store.orgForCustomer(customerId));

  const recorded = await request.store.recordStripeEvent({
    id: event.id,
    type: event.type,
    livemode: event.livemode,
    createdAt: new Date(event.created * 1000),
    payload: event,
    orgId,
  });
  if (!recorded.isNew && recorded.processed) return { outcome: "duplicate", eventId: event.id };

  const ignore = async (reason: string): Promise<WebhookOutcome> => {
    await request.store.finishStripeEvent(recorded.rowId, null);
    return { outcome: "ignored", eventId: event.id, reason };
  };

  if (event.livemode !== request.livemode)
    return ignore("Event mode does not match the configured key");
  if (subscription === null && session === null) return ignore(`No action for ${event.type}`);
  if (orgId === null)
    return ignore(`The ${subscription ? "subscription" : "payment"} names no org`);

  let apply: () => Promise<string>;
  if (subscription !== null) {
    if (customerId === null) return ignore("The subscription names no customer");
    const read = readSubscriptionItems(request.registry, subscription);
    if ("ignore" in read) return ignore(read.ignore);
    apply = () =>
      request.store.syncSubscription({
        orgId,
        customerId,
        subscriptionId: subscription.id,
        planCode: read.planCode,
        interval: read.interval,
        status: event.type === "customer.subscription.deleted" ? "canceled" : subscription.status,
        currentPeriodEnd: read.periodEnd === null ? null : new Date(read.periodEnd * 1000),
        livemode: event.livemode,
        extraSeats: read.extraSeats,
      });
  } else {
    const paid = session as Stripe.Checkout.Session;
    if (paid.mode !== "payment")
      return ignore("Subscription checkouts apply through subscription events");
    if (paid.payment_status !== "paid") return ignore("The checkout is not paid yet");
    const addonCode = paid.metadata?.["addon_code"];
    const addon = request.registry.addons.find((a) => a.code === addonCode) ?? null;
    if (addon === null) return ignore("The checkout sold no add-on");
    const quantity = Number(paid.metadata?.["quantity"] ?? "1");
    if (!Number.isInteger(quantity) || quantity < 1)
      return ignore("The checkout names no quantity");
    apply = async () => {
      await request.store.recordAddonPurchase({
        orgId,
        addonCode: addon.code,
        quantity,
        checkoutSessionId: paid.id,
        currency: (paid.currency ?? "usd").toUpperCase(),
        amountTotalMinor: paid.amount_subtotal ?? paid.amount_total ?? 0,
        livemode: event.livemode,
        paidAt: new Date(event.created * 1000),
      });
      return "recorded";
    };
  }

  try {
    const state = await apply();
    await request.store.finishStripeEvent(recorded.rowId, null);
    return { outcome: "applied", eventId: event.id, state };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await request.store.finishStripeEvent(recorded.rowId, message);
    return { outcome: "failed", eventId: event.id, error: message };
  }
}
