"use server";

import {
  BillingNotConfiguredError,
  CheckoutCompletedError,
  NotSelfServeError,
  PauseRefusedError,
  PriceNotFoundError,
  billingConfigured,
  billingLivemode,
  createStripeClient,
  openBillingPortal,
  RENEWAL_TERMS_VERSION,
  pauseSubscription,
  resumeSubscription,
  startPlanCheckout,
} from "@xos/platform/billing";
import { requestPlanEnd } from "@xos/data/billing";
import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { z } from "zod";
import { PLAN_REGISTRY } from "@/lib/billing/plan-registry.generated";
import {
  BillingDataError,
  atlasBillingEnv,
  checkoutAccountStore,
  pauseAccountStore,
} from "@/lib/billing/stripe";
import { renewalWording } from "@/lib/billing/renewal-terms";
import { askStripeToStopNow } from "@/lib/billing/stop-stripe";
import { env } from "@/lib/env";
import { contextFor } from "@/lib/platform/action-context";
import { getOrgTimeZone } from "@/lib/shell/time-zone";
import { done, field, inputError, type PlatformActionState } from "@/lib/platform/state";
import { fromDataError } from "@/lib/platform/data-error";
import { observability } from "@/lib/observability";
import * as enums from "@xos/data/enums";

/**
 * Billing and Plan's actions (ADR 0033 decision 59): open Stripe Checkout to move the org from a
 * trial or Access to a paid plan, and open the Stripe customer portal for an org that pays. The database
 * decides who may (migration 1640: the Owner, after a second factor in the last 15 minutes) before Stripe is
 * called. Each returns the Stripe URL as `value`, and the form sends the browser there. Until the owner sets
 * STRIPE_SECRET_KEY, both answer `billing_not_open` instead of failing.
 *
 * ADR 0156: Checkout opens only after the Owner agreed to the renewal terms on the page, which are recorded word for
 * word, and the Owner can end the plan here with one button.
 */

const refused = (rule: string): PlatformActionState => ({ rule, at: Date.now() });

/** The terms worded now differ from those on the page, for example across midnight or after a price change. */
class RenewalTermsChangedError extends Error {}

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
  if (error instanceof PauseRefusedError) return refused(error.rule);
  if (error instanceof RenewalTermsChangedError) return refused("renewal_terms_changed");
  observability.logger.error("billing action failed", { error: error });
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
      interval: z.enum(enums.billingInterval),
      hash: z.string().regex(/^[0-9a-f]{64}$/),
      initials: z.string().max(12),
    })
    .safeParse({
      plan: field(form, "plan"),
      interval: field(form, "interval"),
      hash: field(form, "hash"),
      initials: field(form, "initials"),
    });
  if (!parsed.success) return inputError();
  // Agreeing is a deliberate act on this request: nothing is ticked or assumed on the Owner's behalf.
  if (field(form, "agree") !== "on") return refused("renewal_consent_required");
  if (parsed.data.interval === "Annual" && parsed.data.initials.length === 0) {
    return refused("renewal_initials_required");
  }
  const billing = atlasBillingEnv();
  if (!billingConfigured(billing)) return refused("billing_not_open");
  try {
    const [stripe, word, zone, locale] = await Promise.all([
      createStripeClient(billing),
      renewalWording(),
      getOrgTimeZone(ctx),
      getLocale(),
    ]);
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
        consent: ({ trialEndsAt }) => {
          const terms = word({
            planCode: parsed.data.plan,
            interval: parsed.data.interval,
            trialEndsAt,
            zone,
          });
          if (terms === null) throw new NotSelfServeError(parsed.data.plan, "quote");
          if (terms.hash !== parsed.data.hash) throw new RenewalTermsChangedError();
          return {
            amountMinor: terms.amountMinor,
            currency: "USD",
            nextChargeOn: terms.nextChargeOn,
            textVersion: RENEWAL_TERMS_VERSION,
            locale,
            statement: terms.statement,
            initials: parsed.data.initials.length > 0 ? parsed.data.initials : null,
          };
        },
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

/**
 * Ends the org's paid plan at the end of the period paid for (ADR 0156): the same online medium as buying it, no second
 * factor and no reason to give. The database queues the cancel first, so it is retried even if Stripe is down now; the
 * Stripe webhook or the worker records that it was accepted, and Billing and Plan shows what Stripe has said.
 */
export async function endPlanAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const billing = atlasBillingEnv();
  if (!billingConfigured(billing)) return refused("billing_not_open");
  const queued = await requestPlanEnd(ctx.viewer.db, {
    orgId: ctx.org.id,
    livemode: billingLivemode(billing),
  });
  if (!queued.ok) return fromDataError(queued.error);
  await askStripeToStopNow(ctx.viewer.db, ctx.org.id);
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return done(queued.data.cancellationId);
}

/**
 * Pauses the org's monthly plan for whole months (B16, ADR 0155 D4): the database's checks (step-up last), then
 * Stripe's own state, then pause_collection, then the record. Answers the pause's start as `value`.
 */
export async function pauseSubscriptionAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const months = z.coerce.number().int().min(1).max(6).safeParse(field(form, "months"));
  if (!months.success) return inputError();
  const billing = atlasBillingEnv();
  if (!billingConfigured(billing)) return refused("billing_not_open");
  try {
    const stripe = await createStripeClient(billing);
    const paused = await pauseSubscription(stripe, pauseAccountStore(ctx.viewer.db), {
      orgId: ctx.org.id,
      months: months.data,
      livemode: billingLivemode(billing),
    });
    revalidatePath(`/${ctx.org.slug}`, "layout");
    return done(paused.pauseId, paused.startsAt);
  } catch (error) {
    return billingFailure(error);
  }
}

/** Resumes the org's billing now, or cancels a pause that has not started (B16). */
export async function resumeSubscriptionAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const billing = atlasBillingEnv();
  if (!billingConfigured(billing)) return refused("billing_not_open");
  try {
    const stripe = await createStripeClient(billing);
    const resumed = await resumeSubscription(stripe, pauseAccountStore(ctx.viewer.db), {
      orgId: ctx.org.id,
      livemode: billingLivemode(billing),
    });
    revalidatePath(`/${ctx.org.slug}`, "layout");
    return done(resumed.pauseId);
  } catch (error) {
    return billingFailure(error);
  }
}
