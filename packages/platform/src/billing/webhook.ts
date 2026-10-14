import Stripe from "stripe";
import type { PlanRegistry } from "@xos/schemas/plans";
import { planForLookupKey, type BillingInterval } from "./plans.ts";

/** What the webhook handler needs from the database (implemented over the 0560 RPCs). */
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

function customerIdOf(customer: string | { readonly id: string } | null): string | null {
  if (customer === null) return null;
  return typeof customer === "string" ? customer : customer.id;
}

/**
 * Verifies a Stripe webhook with the SubtleCrypto provider (works in Node and Deno, needs no API key),
 * stores the event once (idempotent ingestion), and applies subscription events through
 * app.sync_subscription_from_stripe. A redelivered event that was applied is a duplicate; one that
 * failed is applied again.
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
  const customerId = subscription === null ? null : customerIdOf(subscription.customer);
  const metadataOrg = subscription?.metadata["org_id"] ?? null;
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
  if (subscription === null || customerId === null) return ignore(`No action for ${event.type}`);
  if (orgId === null) return ignore("The subscription names no org");

  const item = subscription.items.data[0];
  const match = planForLookupKey(request.registry, item?.price.lookup_key);
  if (item === undefined || match === null)
    return ignore("The subscription's price is not a plan price");

  try {
    const state = await request.store.syncSubscription({
      orgId,
      customerId,
      subscriptionId: subscription.id,
      planCode: match.planCode,
      interval: match.interval,
      status: event.type === "customer.subscription.deleted" ? "canceled" : subscription.status,
      currentPeriodEnd: item.current_period_end ? new Date(item.current_period_end * 1000) : null,
      livemode: event.livemode,
    });
    await request.store.finishStripeEvent(recorded.rowId, null);
    return { outcome: "applied", eventId: event.id, state };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await request.store.finishStripeEvent(recorded.rowId, message);
    return { outcome: "failed", eventId: event.id, error: message };
  }
}
