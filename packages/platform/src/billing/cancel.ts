import type Stripe from "stripe";
import { CheckoutCompletedError, expireCheckoutSession } from "./upgrade.ts";
import type { StripeClient, StripeClientLimits } from "./env.ts";

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

/**
 * What the worker allows Stripe, so a Stripe that hangs cannot use up the Edge Function's wall clock before certificates and
 * domains have run. A failed call is not retried inside the run: it stays queued, and the next try has its own key.
 */
export const STRIPE_WORKER_LIMITS: StripeClientLimits = { timeoutMs: 8_000, maxNetworkRetries: 0 };

/** How long one run of the worker spends on Stripe before leaving the rest for the next run, 5 minutes later. */
export const STRIPE_WORKER_BUDGET_MS = 45_000;

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

/**
 * Stripe's two terminal statuses, as app.reconcile_stripe_subscription reads them: a subscription in either can never charge
 * again, and Stripe refuses a cancel of it.
 */
export function stripeStatusEnded(status: string): boolean {
  return status === "canceled" || status === "incomplete_expired";
}

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
        if (stripeStatusEnded(current.status)) return { accepted: true, stripeStatus: current.status };
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
  /** The run hit its time budget, so some cancels or sessions wait for the next one. */
  readonly outOfTime: boolean;
}

/**
 * One run of the worker:
 *   1. open alerts go to the platform owner, before Stripe is called: an alert the last run or the database raised goes out
 *      whatever Stripe does next, and a delay cannot clear itself unseen
 *   2. cancels due (none without a Stripe key: they stay queued, and the database's watch raises the alert), one claim at a
 *      time until the time budget is spent, so what this run cannot reach stays due and unclaimed for the next
 *   3. Checkout sessions still open on an org that is ending are expired, so nobody can pay for a plan on it. One paid
 *      in that moment syncs through the webhook, whose reconciliation queues its cancel.
 *   4. alerts again, for what this run raised. An alert that cannot be sent stays unsent, the run counts it, and the next
 *      run tries again; the caller logs it so Sentry and the logs see it whatever the mail does.
 */
export async function runStripeCancellations(input: {
  readonly stripe: StripeClient | null;
  readonly store: StripeCancellationStore;
  readonly worker: string;
  readonly livemode: boolean;
  readonly sink: BillingAlertSink | null;
  readonly limit?: number;
  /** How long this run may spend on Stripe. */
  readonly budgetMs?: number;
  /** The current time in milliseconds, for tests. */
  readonly clock?: () => number;
}): Promise<StripeCancellationRun> {
  const { stripe, store } = input;
  const clock = input.clock ?? Date.now;
  const startedAt = clock();
  const budgetMs = input.budgetMs ?? STRIPE_WORKER_BUDGET_MS;
  let accepted = 0;
  let failed = 0;
  let checkoutsClosed = 0;
  let outOfTime = false;
  const inTime = () => {
    if (clock() - startedAt < budgetMs) return true;
    outOfTime = true;
    return false;
  };
  let alertsSent = 0;
  let alertsWaiting = 0;
  const sendAlerts = async () => {
    alertsWaiting = 0;
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
  };
  await sendAlerts();
  if (stripe !== null) {
    for (let sent = 0; sent < (input.limit ?? 20) && inTime(); sent += 1) {
      const [job] = await store.claim({
        worker: input.worker,
        livemode: input.livemode,
        limit: 1,
      });
      if (job === undefined) break;
      const outcome = await sendStripeCancel(stripe, job);
      await store.finish({ cancellationId: job.cancellationId, outcome });
      if (outcome.accepted) accepted += 1;
      else failed += 1;
    }
    for (const sessionId of await store.checkoutsToClose(input.livemode)) {
      if (!inTime()) break;
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
  await sendAlerts();
  return { accepted, failed, checkoutsClosed, alertsSent, alertsWaiting, outOfTime };
}
