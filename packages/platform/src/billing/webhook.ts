import type Stripe from "stripe";
import type { PlanRegistry } from "@xos/schemas/plans";
import {
  bookPriceFor,
  extraSeatForLookupKey,
  planForLookupKey,
  type BillingInterval,
} from "./plans.ts";

/** What the webhook handler needs from the database (implemented over the 0560, 1250 and 1640 RPCs). */
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
    /** Quantity of the plan's extra-seat price; 0 without one (ADR 0035). */
    readonly extraSeats: number;
    /**
     * Stripe's pause_collection (B16, 6051): set, with when Stripe resumes collecting (null when it gave no date), or
     * null when collection is not paused. A paused status passes through `status`.
     */
    readonly pauseCollection: { readonly resumesAt: Date | null } | null;
    /** The event's created time: Stripe does not order its events, so an older one changes no pause. */
    readonly eventCreatedAt: Date;
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
  /**
   * Records that a Checkout session Atlas opened completed or expired (1640). False when Atlas never
   * opened it, such as an add-on payment.
   */
  finishCheckout(sessionId: string, state: "Completed" | "Expired"): Promise<boolean>;
  /**
   * app.reconcile_stripe_subscription (6140), before the sync: proceed for an ordinary subscription; anything else means
   * the org is gone or ending, or XOS already asked Stripe to stop, so the sync must not run. Runs for a subscription of
   * any price, because a stray one on a deleted org can charge as well.
   */
  reconcileSubscription(input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly subscriptionId: string;
    readonly status: string;
    readonly livemode: boolean;
    readonly eventCreatedAt: Date;
  }): Promise<string>;
  /** app.note_stripe_subscription_terms (6140), after the sync: when Stripe ends it and what each period charges. */
  noteSubscriptionTerms(input: {
    readonly subscriptionId: string;
    readonly cancelAt: Date | null;
    readonly amountMinor: number | null;
    readonly currency: string | null;
    readonly eventCreatedAt: Date;
  }): Promise<boolean>;
  /** app.note_stripe_charge (6140): a paid invoice, which raises an alert when XOS was asked to stop that subscription. */
  noteCharge(input: {
    readonly subscriptionId: string;
    readonly invoiceId: string;
    readonly amountMinor: number;
    readonly currency: string;
    readonly billingReason: string | null;
    readonly paidAt: Date;
  }): Promise<boolean>;
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
  /** Clock for the signature's five-minute tolerance, in epoch milliseconds; the current time when omitted. */
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

/**
 * Checkout events: a completed session ends a plan checkout Atlas opened (1640) or pays for a one-time
 * add-on; a later successful payment can complete an add-on; an expired session closes a checkout.
 */
const CHECKOUT_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.expired",
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

/** Stripe's pause_collection of a subscription, with its resume date (B16, 6051), or null when not paused. */
function pauseCollectionOf(
  subscription: Stripe.Subscription,
): { readonly resumesAt: Date | null } | null {
  const pause = subscription.pause_collection;
  if (pause === null || pause === undefined) return null;
  return {
    resumesAt: typeof pause.resumes_at === "number" ? new Date(pause.resumes_at * 1000) : null,
  };
}

/**
 * What the subscription charges each period before tax, in the currency it pays in. A multi-currency price (stripe-setup
 * gives each one currency_options) states only its default currency on the subscription, so a subscriber in another currency
 * reads the price's own option when the event expanded it, else the price book. The amount is null when none of them says,
 * so a notice never quotes the default currency's amount to someone Stripe charges in another.
 */
function recurringAmount(
  registry: PlanRegistry,
  subscription: Stripe.Subscription,
): { readonly amountMinor: number | null; readonly currency: string | null } {
  const items = subscription.items.data;
  const currency = subscription.currency ?? items[0]?.price.currency ?? null;
  if (currency === null) return { amountMinor: null, currency: null };
  let amountMinor = 0;
  for (const item of items) {
    const { price } = item;
    const option = price.currency_options?.[currency]?.unit_amount;
    const unit =
      typeof option === "number"
        ? option
        : price.currency === currency && typeof price.unit_amount === "number"
          ? price.unit_amount
          : bookPriceFor(registry, price.lookup_key, currency);
    if (unit === null) return { amountMinor: null, currency };
    amountMinor += unit * (item.quantity ?? 1);
  }
  return { amountMinor, currency };
}

/** When Stripe will end the subscription because a cancel was accepted, or null while it renews. */
function cancelAtOf(subscription: Stripe.Subscription, periodEnd: number | null): Date | null {
  if (typeof subscription.cancel_at === "number") return new Date(subscription.cancel_at * 1000);
  if (subscription.cancel_at_period_end && periodEnd !== null) return new Date(periodEnd * 1000);
  return null;
}

/** The subscription an invoice bills, in the pinned API's shape or the older top-level field. */
function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const nested = invoice.parent?.subscription_details?.subscription;
  const older = (invoice as unknown as { readonly subscription?: string | { id: string } | null })
    .subscription;
  const found = nested ?? older ?? null;
  return typeof found === "string" ? found : (found?.id ?? null);
}

/**
 * Verifies a Stripe webhook with the SubtleCrypto provider (works in Node and Deno, needs no API key),
 * stores the event once (idempotent ingestion), and applies:
 *   - subscription events through app.reconcile_stripe_subscription first (6140): a live subscription on a deleted or
 *     ending org, or one XOS already asked to stop, is queued for cancel and raises an alert, and never reaches the sync
 *   - then app.sync_subscription_from_stripe, with the plan from the plan price's lookup key, the extra seats from the
 *     quantity of the plan's extra-seat price, and the pause (pause_collection, a paused status and the event's created
 *     time, B16), then app.note_stripe_subscription_terms for the cancel date and the amount each period charges
 *   - paid invoices through app.note_stripe_charge, which raises an alert when XOS was asked to stop that subscription
 *   - completed and expired plan checkouts Atlas opened through app.finish_billing_checkout_from_stripe
 *     (1640); the plan itself follows the subscription events
 *   - completed, paid Checkout sessions for a one-time add-on through
 *     app.record_addon_purchase_from_stripe (ADR 0035)
 * A redelivered event that was applied is a duplicate; one that failed is applied again. The Stripe SDK
 * loads only once a request carries a signature to check (A85, the Edge boot budgets).
 */
export async function handleStripeWebhook(request: StripeWebhookRequest): Promise<WebhookOutcome> {
  if (request.signature === null || request.signature.length === 0) {
    throw new StripeSignatureError("Missing Stripe-Signature header");
  }
  const { default: StripeSdk } = await import("stripe");
  let event: Stripe.Event;
  try {
    event = await StripeSdk.webhooks.constructEventAsync(
      request.rawBody,
      request.signature,
      request.webhookSecret,
      undefined,
      StripeSdk.createSubtleCryptoProvider(),
      request.receivedAt,
    );
  } catch (error) {
    throw new StripeSignatureError(error instanceof Error ? error.message : String(error));
  }

  const subscription = SUBSCRIPTION_EVENTS.has(event.type)
    ? (event.data.object as Stripe.Subscription)
    : null;
  const session = CHECKOUT_EVENTS.has(event.type)
    ? (event.data.object as Stripe.Checkout.Session)
    : null;
  const invoice = event.type === "invoice.paid" ? (event.data.object as Stripe.Invoice) : null;
  const customerId =
    subscription !== null
      ? customerIdOf(subscription.customer)
      : session !== null
        ? customerIdOf(session.customer)
        : null;
  const metadataOrg =
    (subscription ?? session)?.metadata?.["org_id"] ??
    invoice?.parent?.subscription_details?.metadata?.["org_id"] ??
    null;
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
  if (invoice !== null) {
    const subscriptionId = invoiceSubscriptionId(invoice);
    if (subscriptionId === null) return ignore("The invoice bills no subscription");
    try {
      const raised = await request.store.noteCharge({
        subscriptionId,
        invoiceId: invoice.id,
        amountMinor: invoice.amount_paid,
        currency: invoice.currency,
        billingReason: invoice.billing_reason,
        paidAt: new Date(event.created * 1000),
      });
      await request.store.finishStripeEvent(recorded.rowId, null);
      return {
        outcome: "applied",
        eventId: event.id,
        state: raised ? "charged_after_cancel" : "charge_noted",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await request.store.finishStripeEvent(recorded.rowId, message);
      return { outcome: "failed", eventId: event.id, error: message };
    }
  }
  if (subscription === null && session === null) return ignore(`No action for ${event.type}`);
  if (orgId === null)
    return ignore(`The ${subscription ? "subscription" : "payment"} names no org`);

  let apply: () => Promise<string>;
  if (subscription !== null) {
    if (customerId === null) return ignore("The subscription names no customer");
    const status =
      event.type === "customer.subscription.deleted" ? "canceled" : subscription.status;
    const eventCreatedAt = new Date(event.created * 1000);
    let reconciled: string;
    try {
      reconciled = await request.store.reconcileSubscription({
        orgId,
        customerId,
        subscriptionId: subscription.id,
        status,
        livemode: event.livemode,
        eventCreatedAt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await request.store.finishStripeEvent(recorded.rowId, message);
      return { outcome: "failed", eventId: event.id, error: message };
    }
    if (reconciled !== "proceed") {
      await request.store.finishStripeEvent(recorded.rowId, null);
      return { outcome: "applied", eventId: event.id, state: reconciled };
    }
    const read = readSubscriptionItems(request.registry, subscription);
    if ("ignore" in read) return ignore(read.ignore);
    apply = async () => {
      const state = await request.store.syncSubscription({
        orgId,
        customerId,
        subscriptionId: subscription.id,
        planCode: read.planCode,
        interval: read.interval,
        status,
        currentPeriodEnd: read.periodEnd === null ? null : new Date(read.periodEnd * 1000),
        livemode: event.livemode,
        extraSeats: read.extraSeats,
        pauseCollection: pauseCollectionOf(subscription),
        eventCreatedAt,
      });
      const amount = recurringAmount(request.registry, subscription);
      await request.store.noteSubscriptionTerms({
        subscriptionId: subscription.id,
        cancelAt: status === "canceled" ? null : cancelAtOf(subscription, read.periodEnd),
        amountMinor: amount.amountMinor,
        currency: amount.currency,
        eventCreatedAt,
      });
      return state;
    };
  } else {
    const paid = session as Stripe.Checkout.Session;
    const finished =
      event.type === "checkout.session.expired"
        ? "Expired"
        : event.type === "checkout.session.completed" && paid.mode === "subscription"
          ? "Completed"
          : null;
    if (finished !== null) {
      try {
        const opened = await request.store.finishCheckout(paid.id, finished);
        await request.store.finishStripeEvent(recorded.rowId, null);
        return opened
          ? { outcome: "applied", eventId: event.id, state: `checkout_${finished.toLowerCase()}` }
          : { outcome: "ignored", eventId: event.id, reason: "Atlas did not open this checkout" };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await request.store.finishStripeEvent(recorded.rowId, message);
        return { outcome: "failed", eventId: event.id, error: message };
      }
    }
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
