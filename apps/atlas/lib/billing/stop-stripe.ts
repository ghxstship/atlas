import "server-only";
import type { XosClient } from "@xos/data";
import { getStripeCancellations, type StripeCancelMode } from "@xos/data/billing";
import { billingConfigured, createStripeClient, sendStripeCancel } from "@xos/platform/billing";
import { atlasBillingEnv } from "@/lib/billing/stripe";
import { observability } from "@/lib/observability";

/** How long a person waits on Stripe before the page answers; the worker carries on regardless. */
const WAIT_MS = 8_000;

/**
 * Asks Stripe to stop now, for the person waiting (ADR 0161). The cancel is already queued in the database and the
 * org-lifecycle worker retries it until Stripe accepts it, so a failure here loses nothing, and nothing is recorded from
 * here: only the service role can mark a cancel accepted, from the worker or a signed webhook.
 */
export async function askStripeToStopNow(db: XosClient, orgId: string): Promise<void> {
  const billing = atlasBillingEnv();
  if (!billingConfigured(billing)) return;
  const cancellations = await getStripeCancellations(db, orgId);
  if (!cancellations.ok) return;
  const queued = cancellations.data.filter((c) => c.state === "Queued");
  if (queued.length === 0) return;
  try {
    const stripe = await createStripeClient(billing);
    const sends = Promise.all(
      queued.map((c) =>
        sendStripeCancel(stripe, {
          cancellationId: c.id,
          stripeSubscriptionId: c.stripeSubscriptionId,
          mode: c.mode,
          attempt: "atlas",
        }),
      ),
    );
    await Promise.race([sends, new Promise((resolve) => setTimeout(resolve, WAIT_MS))]);
  } catch (error) {
    observability.logger.error("asking Stripe to stop failed; the worker retries", { error });
  }
}

/**
 * What Stripe itself says about a cancel the webhook has not settled yet, for a page telling the person where it stands.
 * True when Stripe has already stopped the subscription. Any doubt is false, so the page never claims it stopped.
 */
export async function stripeHasStopped(
  stripeSubscriptionId: string,
  mode: StripeCancelMode,
): Promise<boolean> {
  const billing = atlasBillingEnv();
  if (!billingConfigured(billing)) return false;
  try {
    const stripe = await createStripeClient(billing);
    const read = stripe.subscriptions
      .retrieve(stripeSubscriptionId)
      .then((subscription) =>
        mode === "Immediately"
          ? subscription.status === "canceled"
          : subscription.cancel_at_period_end || subscription.cancel_at !== null,
      );
    const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000));
    return await Promise.race([read, timeout]);
  } catch {
    return false;
  }
}
