import type Stripe from "stripe";
import type { StripeClient } from "./env.ts";

/**
 * Pausing a monthly Stripe subscription between seasons (B16, ADR 0155 D4; migration 3051). The database decides who
 * may and when (app.begin_subscription_pause, step-up last) and records the pause; this module calls Stripe between
 * its checks, as upgrade.ts does for Checkout. XOS never holds funds: Stripe stops collecting with pause_collection
 * behavior void, so invoices made during the pause are voided, and resumes one hour before the XOS resume so the
 * invoice at the boundary is collected.
 *
 * The database cannot see a Stripe trial (it maps trialing to active), so the subscription is read from Stripe first
 * and a trial, an existing pause_collection, an inactive status or a plan item that is not monthly is refused here,
 * before Stripe is changed.
 */

/** What pausing and resuming need from the database (migration 3051). Refusals are thrown as the store throws them. */
export interface PauseAccountStore {
  /** app.begin_subscription_pause: the Stripe subscription and when the pause starts and resumes. */
  begin(input: {
    readonly orgId: string;
    readonly months: number;
    readonly livemode: boolean;
  }): Promise<{
    readonly stripeSubscriptionId: string;
    readonly startsAt: string;
    readonly resumesAt: string;
  }>;
  /** app.record_subscription_pause: records the Owner's pause once Stripe set pause_collection. */
  record(input: {
    readonly orgId: string;
    readonly months: number;
    readonly livemode: boolean;
    readonly stripeSubscriptionId: string;
  }): Promise<string>;
  /** app.begin_subscription_resume: the Stripe subscription and whether the pause has started. */
  beginResume(input: {
    readonly orgId: string;
    readonly livemode: boolean;
  }): Promise<{ readonly stripeSubscriptionId: string; readonly started: boolean }>;
  /** app.record_subscription_resume: ends the pause as Resumed by Owner. */
  recordResume(input: { readonly orgId: string; readonly livemode: boolean }): Promise<string>;
}

export type PauseRefusalRule =
  "pause_trial" | "pause_open" | "pause_annual" | "pause_not_active" | "pause_needs_payment_method";

/** Stripe's subscription cannot pause or resume as asked; the rule names why. Nothing in Stripe changed. */
export class PauseRefusedError extends Error {
  readonly rule: PauseRefusalRule;
  constructor(rule: PauseRefusalRule, message: string) {
    super(message);
    this.name = "PauseRefusedError";
    this.rule = rule;
  }
}

/** One hour before the XOS resume, as Stripe's unix seconds. */
export function stripeResumesAt(resumesAt: string): number {
  return Math.floor(Date.parse(resumesAt) / 1000) - 3600;
}

interface SubscriptionView {
  readonly status?: string;
  readonly trial_end?: number | null;
  readonly pause_collection?: unknown;
  readonly items?: {
    readonly data?: readonly {
      readonly price?: { readonly recurring?: { readonly interval?: string } | null };
    }[];
  };
}

/** Why Stripe's subscription cannot pause now, or null when it can. */
export function pauseRefusal(subscription: SubscriptionView, now: Date): PauseRefusedError | null {
  if (typeof subscription.trial_end === "number" && subscription.trial_end * 1000 > now.getTime()) {
    return new PauseRefusedError(
      "pause_trial",
      "A trial cannot pause. Pause once the plan is paid.",
    );
  }
  if (subscription.status !== "active") {
    return new PauseRefusedError(
      "pause_not_active",
      `The Stripe subscription is ${subscription.status ?? "unknown"}, so it cannot pause.`,
    );
  }
  if (subscription.pause_collection !== null && subscription.pause_collection !== undefined) {
    return new PauseRefusedError("pause_open", "Billing is already paused in Stripe.");
  }
  const intervals = (subscription.items?.data ?? []).map((i) => i.price?.recurring?.interval);
  if (intervals.some((i) => i !== undefined && i !== "month")) {
    return new PauseRefusedError(
      "pause_annual",
      "An annual plan is paid for the year and cannot pause.",
    );
  }
  return null;
}

/**
 * Pauses the org's subscription for whole months:
 *   1. the database's checks, step-up last (a refusal from the store)
 *   2. Stripe's subscription is read, and a trial, an open pause, an inactive status or a yearly item is refused
 *   3. pause_collection is set: behavior void, resuming an hour before the XOS resume
 *   4. the pause is recorded
 * Returns when it starts and resumes.
 */
export async function pauseSubscription(
  stripe: StripeClient,
  store: PauseAccountStore,
  request: {
    readonly orgId: string;
    readonly months: number;
    readonly livemode: boolean;
    readonly now?: Date;
  },
): Promise<{ readonly pauseId: string; readonly startsAt: string; readonly resumesAt: string }> {
  const begun = await store.begin({
    orgId: request.orgId,
    months: request.months,
    livemode: request.livemode,
  });
  const subscription = (await stripe.subscriptions.retrieve(
    begun.stripeSubscriptionId,
  )) as SubscriptionView;
  const refusal = pauseRefusal(subscription, request.now ?? new Date());
  if (refusal !== null) throw refusal;
  await stripe.subscriptions.update(begun.stripeSubscriptionId, {
    pause_collection: { behavior: "void", resumes_at: stripeResumesAt(begun.resumesAt) },
  });
  const pauseId = await store.record({
    orgId: request.orgId,
    months: request.months,
    livemode: request.livemode,
    stripeSubscriptionId: begun.stripeSubscriptionId,
  });
  return { pauseId, startsAt: begun.startsAt, resumesAt: begun.resumesAt };
}

/** Stripe's answer when resuming needs a card first (a trial that ended without one). */
function needsPaymentMethod(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { readonly code?: unknown; readonly message?: unknown };
  return (
    e.code === "payment_method_required" ||
    (typeof e.message === "string" && /payment method/i.test(e.message))
  );
}

/**
 * Resumes the org's subscription now:
 *   1. the database's checks, step-up last
 *   2. Stripe's subscription is read: a paused status (a trial that ended without a card) is resumed with a new
 *      period from now; otherwise pause_collection is cleared, and once the pause has started a new period starts
 *      today with no proration and is charged at once (a failed charge enters dunning as usual)
 *   3. the resume is recorded
 */
export async function resumeSubscription(
  stripe: StripeClient,
  store: PauseAccountStore,
  request: { readonly orgId: string; readonly livemode: boolean },
): Promise<{ readonly pauseId: string; readonly started: boolean }> {
  const begun = await store.beginResume({ orgId: request.orgId, livemode: request.livemode });
  const subscription = (await stripe.subscriptions.retrieve(
    begun.stripeSubscriptionId,
  )) as SubscriptionView;
  if (subscription.status === "paused") {
    try {
      const params: Stripe.SubscriptionResumeParams = { billing_cycle_anchor: { type: "now" } };
      await stripe.subscriptions.resume(begun.stripeSubscriptionId, params);
    } catch (error) {
      if (needsPaymentMethod(error)) {
        throw new PauseRefusedError(
          "pause_needs_payment_method",
          "Add a payment method in the billing portal, then resume.",
        );
      }
      throw error;
    }
  } else {
    const params: Stripe.SubscriptionUpdateParams = { pause_collection: "" };
    if (begun.started) {
      // The pinned API version takes the anchor as an object (stripe 23).
      params.billing_cycle_anchor = { type: "now" };
      params.proration_behavior = "none";
    }
    await stripe.subscriptions.update(begun.stripeSubscriptionId, params);
  }
  const pauseId = await store.recordResume({ orgId: request.orgId, livemode: request.livemode });
  return { pauseId, started: begun.started };
}
