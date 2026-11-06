import { optionalText, rows, text, type PlatformDb } from "../stores.ts";
import type { StripeCancelMode, StripeCancellationStore } from "./cancel.ts";

/**
 * The Stripe cancels of the org-lifecycle worker, over the 6140 RPCs (ADR 0161). In its own module so the Stripe webhook,
 * which shares stores.ts, does not load it when it boots.
 */
export function stripeCancellationStore(db: PlatformDb): StripeCancellationStore {
  return {
    async claim(input) {
      return rows(
        await db.rpc("claim_stripe_cancellations", {
          p_worker: input.worker,
          p_livemode: input.livemode,
          p_limit: input.limit,
        }),
      ).map((row) => ({
        cancellationId: text(row, "cancellation_id"),
        stripeSubscriptionId: text(row, "stripe_subscription_id"),
        mode: text(row, "cancel_mode") as StripeCancelMode,
        attempt: Number(row["attempt"]),
      }));
    },
    async finish({ cancellationId, outcome }) {
      await db.rpc("finish_stripe_cancellation", {
        p_id: cancellationId,
        p_accepted: outcome.accepted,
        p_stripe_status: outcome.accepted ? outcome.stripeStatus : null,
        p_error: outcome.accepted ? null : outcome.error,
      });
    },
    async checkoutsToClose(livemode) {
      return rows(await db.rpc("stripe_checkouts_to_close", { p_livemode: livemode })).map((row) =>
        text(row, "stripe_checkout_session_id"),
      );
    },
    async closeCheckout(sessionId) {
      await db.rpc("finish_billing_checkout_from_stripe", {
        p_stripe_checkout_session_id: sessionId,
        p_checkout_state: "Expired",
      });
    },
    async alertsToSend() {
      return rows(await db.rpc("billing_alerts_to_send", { p_limit: 50 })).map((row) => ({
        alertId: text(row, "alert_id"),
        kind: text(row, "alert_kind"),
        orgId: optionalText(row, "subject_org_id"),
        stripeSubscriptionId: optionalText(row, "stripe_subscription_id"),
        detail: text(row, "detail"),
        raisedAt: text(row, "raised_at"),
      }));
    },
    async markAlertSent(alertId) {
      await db.rpc("mark_billing_alert_sent", { p_alert_id: alertId });
    },
  };
}
