import type { PlanRegistry } from "@xos/schemas/plans";
import { createCheckoutSession, createPortalSession, findPortalConfiguration } from "./checkout.ts";
import type { StripeClient } from "./env.ts";
import { lookupKeyFor, type BillingInterval } from "./plans.ts";

/**
 * Moving an org from a trial or Access to a paid plan, and managing a paid plan (ADR 0033
 * decision 59). The database decides who may and when (migration 1640, as the signed-in Owner); this
 * module calls Stripe between its checks. Atlas's billing actions run it with the Stripe client and a
 * store over @xos/data.
 */

/** What starting a checkout and opening the portal need from the database (migration 1640). */
export interface CheckoutAccountStore {
  /** app.begin_billing_checkout: refuses, or returns the org's customer, trial end and open sessions. */
  begin(input: {
    readonly orgId: string;
    readonly planCode: string;
    readonly livemode: boolean;
  }): Promise<{
    readonly customerId: string | null;
    readonly trialEndsAt: string | null;
    readonly openSessionIds: readonly string[];
  }>;
  /** app.record_billing_checkout: records the session and returns the open ones it closed. */
  record(input: {
    readonly orgId: string;
    readonly planCode: string;
    readonly interval: BillingInterval;
    readonly sessionId: string;
    readonly livemode: boolean;
    readonly expiresAt: Date;
  }): Promise<readonly string[]>;
  /** app.billing_portal_customer: refuses, or returns the org's Stripe customer. */
  portalCustomer(input: { readonly orgId: string; readonly livemode: boolean }): Promise<string>;
}

/** A checkout of the org completed in Stripe moments ago; its plan is on its way through the webhook. */
export class CheckoutCompletedError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`Checkout session ${sessionId} already completed; the plan syncs through the webhook`);
    this.name = "CheckoutCompletedError";
    this.sessionId = sessionId;
  }
}

/** Stripe's answer for an id the account does not have (StripeInvalidRequestError, code resource_missing). */
function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly code?: unknown }).code === "resource_missing"
  );
}

/**
 * Expires an open Checkout session. Refuses with CheckoutCompletedError when it completed instead, so
 * the org never pays twice; an expired session needs nothing, and neither does one the Stripe account does
 * not have (recorded under an earlier sandbox account or key), which nobody can pay.
 */
export async function expireCheckoutSession(
  stripe: StripeClient,
  sessionId: string,
): Promise<void> {
  const session = await stripe.checkout.sessions.retrieve(sessionId).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (session === null) return;
  if (session.status === "complete") throw new CheckoutCompletedError(sessionId);
  if (session.status !== "open") return;
  try {
    await stripe.checkout.sessions.expire(sessionId);
  } catch (error) {
    // Paid or expired between the two calls: Stripe's answer now decides.
    const again = await stripe.checkout.sessions.retrieve(sessionId);
    if (again.status === "complete") throw new CheckoutCompletedError(sessionId);
    if (again.status !== "open") return;
    throw error;
  }
}

export interface PlanCheckoutRequest {
  readonly orgId: string;
  readonly planCode: string;
  readonly interval: BillingInterval;
  /** The mode of the Stripe key, which every Stripe id the database stores is checked against. */
  readonly livemode: boolean;
  /** The Owner's email, for the org's first checkout; later ones reuse its Stripe customer. */
  readonly customerEmail?: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  /** The current time, for tests. */
  readonly now?: Date;
}

/**
 * Opens Stripe Checkout for a self-serve plan:
 *   1. the plan has Stripe prices in plans.yaml (NotSelfServeError for Access or a quoted plan)
 *   2. the database's checks, step-up last (a refusal from the store)
 *   3. the org's open sessions are expired, or CheckoutCompletedError when one was paid meanwhile
 *   4. the session opens on the org's Stripe customer, carrying the rest of a running trial
 *   5. the session is recorded; any session another tab opened in the meantime is expired too
 * Returns the URL to send the Owner to.
 */
export async function startPlanCheckout(
  stripe: StripeClient,
  registry: PlanRegistry,
  store: CheckoutAccountStore,
  request: PlanCheckoutRequest,
): Promise<{ readonly sessionId: string; readonly url: string }> {
  lookupKeyFor(registry, request.planCode, request.interval);
  const account = await store.begin({
    orgId: request.orgId,
    planCode: request.planCode,
    livemode: request.livemode,
  });
  for (const id of account.openSessionIds) await expireCheckoutSession(stripe, id);
  const session = await createCheckoutSession(stripe, registry, {
    orgId: request.orgId,
    planCode: request.planCode,
    interval: request.interval,
    ...(account.customerId !== null
      ? { customerId: account.customerId }
      : request.customerEmail !== undefined
        ? { customerEmail: request.customerEmail }
        : {}),
    ...(account.trialEndsAt === null ? {} : { trialEnd: account.trialEndsAt }),
    successUrl: request.successUrl,
    cancelUrl: request.cancelUrl,
    ...(request.now === undefined ? {} : { now: request.now }),
  });
  const closed = await store.record({
    orgId: request.orgId,
    planCode: request.planCode,
    interval: request.interval,
    sessionId: session.sessionId,
    livemode: request.livemode,
    expiresAt: session.expiresAt,
  });
  for (const id of closed) {
    try {
      await expireCheckoutSession(stripe, id);
    } catch (error) {
      if (!(error instanceof CheckoutCompletedError)) throw error;
      // The other tab paid: this session must never be paid as well.
      await expireCheckoutSession(stripe, session.sessionId);
      throw error;
    }
  }
  return { sessionId: session.sessionId, url: session.url };
}

/**
 * Opens the Stripe customer portal for the org's customer after the database's checks (step-up), with
 * the portal configuration `stripe:setup` created when it exists. Returns the portal URL.
 */
export async function openBillingPortal(
  stripe: StripeClient,
  store: CheckoutAccountStore,
  request: { readonly orgId: string; readonly livemode: boolean; readonly returnUrl: string },
): Promise<string> {
  const customer = await store.portalCustomer({
    orgId: request.orgId,
    livemode: request.livemode,
  });
  const configuration = await findPortalConfiguration(stripe);
  return createPortalSession(stripe, customer, request.returnUrl, configuration);
}
