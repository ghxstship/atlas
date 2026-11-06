import type Stripe from "stripe";
import { CheckoutCompletedError, expireCheckoutSession } from "./upgrade.ts";
import type { StripeClient } from "./env.ts";

/**
 * Stopping a Stripe subscription (ADR 0161, migration 6140). The database queues every cancel in the transaction that
 * ends the org or the plan, and only the service role records that Stripe accepted it. This module makes the call: the
 * org-lifecycle worker retries what is due, and Atlas tries once at once for the person waiting.
 *
 * An immediate cancel has no proration and no final invoice, because Terms 5.10 refunds no unused time unless the law
 * requires it. Asking twice is safe: Stripe answers a second cancel with resource_missing, which counts as accepted. The
 * idempotency key changes with each attempt, since Stripe replays a stored failure for 24 hours under the same key and a
 * retry must reach Stripe again.
 */

/** How a cancel stops the subscription, matching app.stripe_cancel_mode. */
// eslint-disable-next-line xos/no-restated-enums -- below @xos/data; test/database-enums.test.ts holds it equal
export type StripeCancelMode = "Immediately" | "At Period End";

/** One cancel to send. */
export interface StripeCancelJob {
  readonly cancellationId: string;
  readonly stripeSubscriptionId: string;
  readonly mode: StripeCancelMode;
  /** What makes this try's idempotency key unique: the attempt number, or the caller's name. */
  readonly attempt: number | string;
}

export type StripeCancelOutcome =
  | { readonly accepted: true; readonly stripeStatus: string }
  | { readonly accepted: false; readonly error: string };

/** The idempotency key of one try at one cancel. */
export function stripeCancelIdempotencyKey(job: StripeCancelJob): string {
  return `xos-stripe-cancel:${job.cancellationId}:${String(job.attempt)}`;
}

function errorField(error: unknown, field: "code" | "type"): unknown {
  return typeof error === "object" && error !== null
    ? (error as Record<string, unknown>)[field]
    : undefined;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000);
}

/** Calls Stripe once for one cancel and says what it answered. Never throws: a failure is an outcome to retry. */
export async function sendStripeCancel(
  stripe: StripeClient,
  job: StripeCancelJob,
): Promise<StripeCancelOutcome> {
  const options: Stripe.RequestOptions = { idempotencyKey: stripeCancelIdempotencyKey(job) };
  try {
    const subscription =
      job.mode === "Immediately"
        ? await stripe.subscriptions.cancel(
            job.stripeSubscriptionId,
            { prorate: false, invoice_now: false },
            options,
          )
        : await stripe.subscriptions.update(
            job.stripeSubscriptionId,
            { cancel_at_period_end: true },
            options,
          );
    return { accepted: true, stripeStatus: subscription.status };
  } catch (error) {
    // Stripe no longer has it, or it already ended, so it cannot charge.
    if (errorField(error, "code") === "resource_missing") {
      return { accepted: true, stripeStatus: "missing" };
    }
    if (errorField(error, "type") === "StripeInvalidRequestError") {
      try {
        const current = await stripe.subscriptions.retrieve(job.stripeSubscriptionId);
        if (current.status === "canceled") return { accepted: true, stripeStatus: "canceled" };
      } catch (again) {
        if (errorField(again, "code") === "resource_missing") {
          return { accepted: true, stripeStatus: "missing" };
        }
      }
    }
    return { accepted: false, error: errorText(error) };
  }
}

/** A billing alert the platform owner has not been emailed about. */
export interface BillingAlert {
  readonly alertId: string;
  readonly kind: string;
  readonly orgId: string | null;
  readonly stripeSubscriptionId: string | null;
  readonly detail: string;
  readonly raisedAt: string;
}

/** What the worker needs from the database (6140, service role). */
export interface StripeCancellationStore {
  claim(input: {
    readonly worker: string;
    readonly livemode: boolean;
    readonly limit: number;
  }): Promise<readonly StripeCancelJob[]>;
  finish(input: {
    readonly cancellationId: string;
    readonly outcome: StripeCancelOutcome;
  }): Promise<void>;
  checkoutsToClose(livemode: boolean): Promise<readonly string[]>;
  closeCheckout(sessionId: string): Promise<void>;
  alertsToSend(): Promise<readonly BillingAlert[]>;
  markAlertSent(alertId: string): Promise<void>;
}

/** Where a billing alert goes. The default of the worker emails XOS_BILLING_ALERT_EMAIL. */
export interface BillingAlertSink {
  send(alert: BillingAlert): Promise<void>;
}

export interface StripeCancellationRun {
  readonly accepted: number;
  readonly failed: number;
  readonly checkoutsClosed: number;
  readonly alertsSent: number;
  readonly alertsWaiting: number;
}

/**
 * One run of the worker:
 *   1. cancels due (none without a Stripe key: they stay queued, and the database's watch raises the alert)
 *   2. Checkout sessions still open on an org that is ending are expired, so nobody can pay for a plan on it. One paid
 *      in that moment syncs through the webhook, whose reconciliation queues its cancel.
 *   3. open alerts go to the platform owner. An alert that cannot be sent stays unsent, the run counts it, and the next
 *      run tries again; the caller logs it so Sentry and the logs see it whatever the mail does.
 */
export async function runStripeCancellations(input: {
  readonly stripe: StripeClient | null;
  readonly store: StripeCancellationStore;
  readonly worker: string;
  readonly livemode: boolean;
  readonly sink: BillingAlertSink | null;
  readonly limit?: number;
}): Promise<StripeCancellationRun> {
  const { stripe, store } = input;
  let accepted = 0;
  let failed = 0;
  let checkoutsClosed = 0;
  if (stripe !== null) {
    const jobs = await store.claim({
      worker: input.worker,
      livemode: input.livemode,
      limit: input.limit ?? 20,
    });
    for (const job of jobs) {
      const outcome = await sendStripeCancel(stripe, job);
      await store.finish({ cancellationId: job.cancellationId, outcome });
      if (outcome.accepted) accepted += 1;
      else failed += 1;
    }
    for (const sessionId of await store.checkoutsToClose(input.livemode)) {
      try {
        await expireCheckoutSession(stripe, sessionId);
        await store.closeCheckout(sessionId);
        checkoutsClosed += 1;
      } catch (error) {
        // Paid in that moment: the webhook syncs it, and reconciliation queues its cancel. Anything else retries.
        if (!(error instanceof CheckoutCompletedError)) failed += 1;
      }
    }
  }
  let alertsSent = 0;
  let alertsWaiting = 0;
  for (const alert of await store.alertsToSend()) {
    if (input.sink === null) {
      alertsWaiting += 1;
      continue;
    }
    try {
      await input.sink.send(alert);
      await store.markAlertSent(alert.alertId);
      alertsSent += 1;
    } catch {
      alertsWaiting += 1;
    }
  }
  return { accepted, failed, checkoutsClosed, alertsSent, alertsWaiting };
}
