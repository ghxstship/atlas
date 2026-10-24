import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Billing and Plan's billing calls (owner decision 21 of 2026-10-23, migration 1640): the checks before Atlas
 * opens Stripe Checkout or the customer portal, the record of each Checkout session it opens, and the summary
 * of the org's Stripe billing. Every call runs as the signed-in person, so the database decides who may: the
 * Owner (org.billing.manage) after a second factor in the last 15 minutes. Refusals come back with their rule.
 */

export type BillingInterval = "Monthly" | "Annual";

/** What Checkout needs once the database's checks passed. */
export interface CheckoutStart {
  /** The org's Stripe customer in this mode; null before its first payment. */
  readonly customerId: string | null;
  /** The end of a running trial, which Checkout carries over; null without one. */
  readonly trialEndsAt: string | null;
  /** Checkout sessions of the org still open, to expire before opening another. */
  readonly openSessionIds: readonly string[];
}

/** Text the database returns, or null (the generated types cannot say a returned column is nullable). */
function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** app.begin_billing_checkout: the checkout checks, step-up last. */
export async function beginBillingCheckout(
  db: XosClient,
  input: { readonly orgId: string; readonly planCode: string; readonly livemode: boolean },
): Promise<Result<CheckoutStart>> {
  const { data, error } = await db.rpc("begin_billing_checkout", {
    p_org_id: input.orgId,
    p_plan_code: input.planCode,
    p_livemode: input.livemode,
  });
  if (error) return fail(toDataError(error));
  const row = data[0];
  if (row === undefined) {
    return fail({ kind: "unexpected", message: "begin_billing_checkout returned no row" });
  }
  return ok({
    customerId: textOrNull(row.stripe_customer_id),
    trialEndsAt: textOrNull(row.trial_ends_at),
    openSessionIds: textList(row.open_session_ids),
  });
}

/** app.record_billing_checkout: records the session Stripe opened; returns the open sessions it closed. */
export async function recordBillingCheckout(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly planCode: string;
    readonly interval: BillingInterval;
    readonly sessionId: string;
    readonly livemode: boolean;
    readonly expiresAt: Date;
  },
): Promise<Result<string[]>> {
  const { data, error } = await db.rpc("record_billing_checkout", {
    p_org_id: input.orgId,
    p_plan_code: input.planCode,
    p_billing_interval: input.interval,
    p_stripe_checkout_session_id: input.sessionId,
    p_livemode: input.livemode,
    p_expires_at: input.expiresAt.toISOString(),
  });
  if (error) return fail(toDataError(error));
  return ok(textList(data));
}

/** app.billing_portal_customer: the Stripe customer whose portal the Owner opens, after step-up. */
export async function getBillingPortalCustomer(
  db: XosClient,
  input: { readonly orgId: string; readonly livemode: boolean },
): Promise<Result<string>> {
  const { data, error } = await db.rpc("billing_portal_customer", {
    p_org_id: input.orgId,
    p_livemode: input.livemode,
  });
  if (error) return fail(toDataError(error));
  const customer = textOrNull(data);
  if (customer === null) {
    return fail({ kind: "unexpected", message: "billing_portal_customer returned no customer" });
  }
  return ok(customer);
}

/** The org's Stripe billing in one mode, as Billing and Plan shows it. */
export interface BillingAccount {
  /** The current subscription pays through Stripe: the portal changes it, never a second Checkout. */
  readonly paidThroughStripe: boolean;
  /** The org has a Stripe customer, current or from an ended subscription, so the portal has invoices. */
  readonly hasStripeCustomer: boolean;
  readonly interval: BillingInterval | null;
  readonly currentPeriodEnd: string | null;
}

/** app.billing_account, for people with org.billing.read. */
export async function getBillingAccount(
  db: XosClient,
  orgId: string,
  livemode: boolean,
): Promise<Result<BillingAccount>> {
  const { data, error } = await db.rpc("billing_account", {
    p_org_id: orgId,
    p_livemode: livemode,
  });
  if (error) return fail(toDataError(error));
  const row = data[0];
  if (row === undefined) return fail({ kind: "not-found" });
  const interval = textOrNull(row.billing_interval);
  return ok({
    paidThroughStripe: row.paid_through_stripe,
    hasStripeCustomer: row.has_stripe_customer,
    interval: interval === "Monthly" || interval === "Annual" ? interval : null,
    currentPeriodEnd: textOrNull(row.current_period_end),
  });
}
