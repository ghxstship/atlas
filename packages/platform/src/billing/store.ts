/**
 * The billing store, in its own module so only the functions that bill (stripe-webhook, org-lifecycle) load it: every
 * other Edge Function boots the shared stores chunk without it (merge train 11, boot budgets).
 */
import type { BillingStore } from "./webhook.ts";
import { optionalText, rows, text, type PlatformDb } from "../stores.ts";

/** BillingStore over the 0560, 1250, 1640 and 6810 RPCs. */
export function billingStore(db: PlatformDb): BillingStore {
  return {
    async recordStripeEvent(event) {
      const row = rows(
        await db.rpc("record_stripe_event", {
          p_stripe_event_id: event.id,
          p_event_type: event.type,
          p_livemode: event.livemode,
          p_stripe_created_at: event.createdAt.toISOString(),
          p_payload: event.payload,
          p_org_id: event.orgId,
        }),
      )[0];
      const rowId = text(row, "stripe_event_row_id");
      const stored = await db.selectOne("stripe_events", "processed_at", { id: rowId });
      return {
        rowId,
        isNew: row?.["is_new"] === true,
        processed: optionalText(stored ?? undefined, "processed_at") !== null,
      };
    },
    async finishStripeEvent(rowId, error) {
      await db.rpc("finish_stripe_event", { p_stripe_event_row_id: rowId, p_error: error });
    },
    async orgForCustomer(customerId) {
      const link = await db.selectOne("stripe_subscription_links", "org_id", {
        stripe_customer_id: customerId,
      });
      return optionalText(link ?? undefined, "org_id");
    },
    async syncSubscription(input) {
      const state = await db.rpc("sync_subscription_from_stripe", {
        p_org_id: input.orgId,
        p_stripe_customer_id: input.customerId,
        p_stripe_subscription_id: input.subscriptionId,
        p_plan_code: input.planCode,
        p_billing_interval: input.interval,
        p_stripe_status: input.status,
        p_current_period_end: input.currentPeriodEnd?.toISOString() ?? null,
        p_livemode: input.livemode,
        p_extra_seats: input.extraSeats,
        p_pause_collection: input.pauseCollection !== null,
        p_pause_resumes_at: input.pauseCollection?.resumesAt?.toISOString() ?? null,
        p_event_created_at: input.eventCreatedAt.toISOString(),
      });
      return String(state);
    },
    async recordAddonPurchase(input) {
      const id = await db.rpc("record_addon_purchase_from_stripe", {
        p_org_id: input.orgId,
        p_addon_code: input.addonCode,
        p_quantity: input.quantity,
        p_stripe_checkout_session_id: input.checkoutSessionId,
        p_currency_code: input.currency,
        p_amount_total_minor: input.amountTotalMinor,
        p_livemode: input.livemode,
        p_paid_at: input.paidAt.toISOString(),
      });
      return String(id);
    },
    async reconcileSubscription(input) {
      const state = await db.rpc("reconcile_stripe_subscription", {
        p_org_id: input.orgId,
        p_stripe_customer_id: input.customerId,
        p_stripe_subscription_id: input.subscriptionId,
        p_stripe_status: input.status,
        p_livemode: input.livemode,
        p_event_created_at: input.eventCreatedAt.toISOString(),
      });
      return String(state);
    },
    async noteSubscriptionTerms(input) {
      const applied = await db.rpc("note_stripe_subscription_terms", {
        p_stripe_subscription_id: input.subscriptionId,
        p_cancel_at: input.cancelAt?.toISOString() ?? null,
        p_amount_minor: input.amountMinor,
        p_currency_code: input.currency,
        p_event_created_at: input.eventCreatedAt.toISOString(),
      });
      return applied === true;
    },
    async noteCharge(input) {
      const raised = await db.rpc("note_stripe_charge", {
        p_stripe_subscription_id: input.subscriptionId,
        p_stripe_invoice_id: input.invoiceId,
        p_amount_minor: input.amountMinor,
        p_currency_code: input.currency,
        p_billing_reason: input.billingReason,
        p_paid_at: input.paidAt.toISOString(),
      });
      return raised === true;
    },
    async finishCheckout(sessionId, state) {
      const known = await db.rpc("finish_billing_checkout_from_stripe", {
        p_stripe_checkout_session_id: sessionId,
        p_checkout_state: state,
      });
      return known === true;
    },
  };
}
