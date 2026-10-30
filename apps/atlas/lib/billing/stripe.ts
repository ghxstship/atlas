import "server-only";
import type { DataError, XosClient } from "@xos/data";
import {
  beginBillingCheckout,
  beginSubscriptionPause,
  beginSubscriptionResume,
  getBillingPortalCustomer,
  recordBillingCheckout,
  recordSubscriptionPause,
  recordSubscriptionResume,
} from "@xos/data/billing";
import type { Result } from "@xos/data/result";
import {
  billingConfigured,
  billingLivemode,
  readBillingEnv,
  type BillingEnv,
  type CheckoutAccountStore,
  type PauseAccountStore,
} from "@xos/platform/billing";
import { env } from "@/lib/env";

/**
 * Atlas's side of billing (ADR 0033 decision 59): the Stripe key and its mode from the
 * server environment, and the 1640 RPCs as the store @xos/platform's Checkout and portal run against,
 * as the signed-in person. Without STRIPE_SECRET_KEY billing is not open, and Billing and Plan says so.
 */

/** The billing environment from Atlas's validated server environment. */
export function atlasBillingEnv(): BillingEnv {
  const config = env();
  return readBillingEnv({
    STRIPE_SECRET_KEY: config.STRIPE_SECRET_KEY,
    STRIPE_API_URL: config.STRIPE_API_URL,
    XOS_APP_URL: config.ATLAS_SITE_URL,
  });
}

/** Whether billing is open here, and in which Stripe mode. */
export function billingStatus(): { readonly open: boolean; readonly livemode: boolean } {
  const billing = atlasBillingEnv();
  return { open: billingConfigured(billing), livemode: billingLivemode(billing) };
}

/** A refusal or failure from the database, carried through @xos/platform's billing flow. */
export class BillingDataError extends Error {
  readonly error: DataError;
  constructor(error: DataError) {
    super(error.kind === "refusal" ? error.rule : error.kind);
    this.name = "BillingDataError";
    this.error = error;
  }
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new BillingDataError(result.error);
  return result.data;
}

/** The 1640 RPCs, called as the signed-in person. */
export function checkoutAccountStore(db: XosClient): CheckoutAccountStore {
  return {
    begin: async (input) => unwrap(await beginBillingCheckout(db, input)),
    record: async (input) => unwrap(await recordBillingCheckout(db, input)),
    portalCustomer: async (input) => unwrap(await getBillingPortalCustomer(db, input)),
  };
}

/** The 3051 pause RPCs, called as the signed-in person (B16, ADR 0155 D4). */
export function pauseAccountStore(db: XosClient): PauseAccountStore {
  return {
    begin: async (input) => unwrap(await beginSubscriptionPause(db, input)),
    record: async (input) => unwrap(await recordSubscriptionPause(db, input)),
    beginResume: async (input) => unwrap(await beginSubscriptionResume(db, input)),
    recordResume: async (input) => unwrap(await recordSubscriptionResume(db, input)),
  };
}
