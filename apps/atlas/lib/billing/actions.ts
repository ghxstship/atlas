"use server";

import {
  BillingNotConfiguredError,
  CheckoutCompletedError,
  NotSelfServeError,
  PriceNotFoundError,
  billingConfigured,
  billingLivemode,
  createStripeClient,
  openBillingPortal,
  startPlanCheckout,
} from "@xos/platform/billing";
import { z } from "zod";
import { PLAN_REGISTRY } from "@/lib/billing/plan-registry.generated";
import { BillingDataError, atlasBillingEnv, checkoutAccountStore } from "@/lib/billing/stripe";
import { env } from "@/lib/env";
import { contextFor } from "@/lib/platform/action-context";
import {
  done,
  field,
  fromDataError,
  inputError,
  type PlatformActionState,
} from "@/lib/platform/state";

/**
 * Billing and Plan's actions (ADR 0033 decision 59): open Stripe Checkout to move the org from a
 * trial or Access to a paid plan, and open the Stripe customer portal for an org that pays. The database
 * decides who may (migration 1640: the Owner, after a second factor in the last 15 minutes) before Stripe is
 * called. Each returns the Stripe URL as `value`, and the form sends the browser there. Until the owner sets
 * STRIPE_SECRET_KEY, both answer `billing_not_open` instead of failing.
 */

const refused = (rule: string): PlatformActionState => ({ rule, at: Date.now() });

/** The page Checkout and the portal return to, with what happened. */
function billingPage(slug: string, outcome?: "done" | "canceled"): string {
  const url = new URL(`/${slug}/settings/billing-and-plan`, env().ATLAS_SITE_URL);
  if (outcome !== undefined) url.searchParams.set("checkout", outcome);
  return url.toString();
}

function billingFailure(error: unknown): PlatformActionState {
  if (error instanceof BillingDataError) return fromDataError(error.error);
  if (error instanceof CheckoutCompletedError) return refused("checkout_completed");
  if (error instanceof NotSelfServeError) return refused("plan_not_self_serve");
  if (error instanceof PriceNotFoundError) return refused("billing_price_missing");
  if (error instanceof BillingNotConfiguredError) return refused("billing_not_open");
  console.error("billing action failed", error);
  return { error: "unexpected", at: Date.now() };
}

export async function startCheckoutAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      plan: z.string().regex(/^[a-z][a-z0-9_]*$/),
      interval: z.enum(["Monthly", "Annual"]),
    })
    .safeParse({ plan: field(form, "plan"), interval: field(form, "interval") });
  if (!parsed.success) return inputError();
  const billing = atlasBillingEnv();
  if (!billingConfigured(billing)) return refused("billing_not_open");
  try {
    const stripe = await createStripeClient(billing);
    const session = await startPlanCheckout(
      stripe,
      PLAN_REGISTRY,
      checkoutAccountStore(ctx.viewer.db),
      {
        orgId: ctx.org.id,
        planCode: parsed.data.plan,
        interval: parsed.data.interval,
        livemode: billingLivemode(billing),
        ...(ctx.viewer.email === null ? {} : { customerEmail: ctx.viewer.email }),
        successUrl: billingPage(ctx.org.slug, "done"),
        cancelUrl: billingPage(ctx.org.slug, "canceled"),
      },
    );
    return done(session.sessionId, session.url);
  } catch (error) {
    return billingFailure(error);
  }
}

export async function openBillingPortalAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const billing = atlasBillingEnv();
  if (!billingConfigured(billing)) return refused("billing_not_open");
  try {
    const stripe = await createStripeClient(billing);
    const url = await openBillingPortal(stripe, checkoutAccountStore(ctx.viewer.db), {
      orgId: ctx.org.id,
      livemode: billingLivemode(billing),
      returnUrl: billingPage(ctx.org.slug),
    });
    return done(undefined, url);
  } catch (error) {
    return billingFailure(error);
  }
}
