import "server-only";
import { dateIn } from "@xos/data/calendar";
import type { BillingInterval } from "@xos/data/billing";
import { firstChargeOn, stripeTrialEnd } from "@xos/platform/billing";
import type { PlanPrice } from "@xos/schemas/plans";
import { createHash } from "node:crypto";
import { getFormatter, getTranslations } from "next-intl/server";
import { PLAN_REGISTRY } from "@/lib/billing/plan-registry.generated";

/**
 * The renewal terms of a paid plan (ADR 0161): the one statement the Owner sees before Checkout, agrees to, and has
 * recorded word for word, and that Stripe's page repeats. The page and the server action word it from the same inputs, and
 * the action compares hashes, so what is recorded is exactly what was on the screen.
 */
export interface RenewalTerms {
  readonly planCode: string;
  readonly interval: BillingInterval;
  /** The currency Checkout is told to charge, and the one the statement quotes. */
  readonly currency: string;
  readonly amountMinor: number;
  readonly price: string;
  readonly nextChargeOn: string;
  readonly statement: string;
  readonly hash: string;
}

export type RenewalWording = (input: {
  readonly planCode: string;
  readonly interval: BillingInterval;
  readonly currency: string;
  readonly trialEndsAt: string | null;
  readonly zone: string | null;
  readonly now?: Date;
}) => RenewalTerms | null;

/**
 * The currency Billing and Plan quotes and Checkout charges. Both read this, and Checkout is told to use it, so what an Owner
 * agrees to and what Stripe charges cannot differ.
 */
export const CHECKOUT_CURRENCY = "USD";

/** The wording function in the person's language. Null for a plan sold by quote or free. */
export async function renewalWording(): Promise<RenewalWording> {
  const [t, format] = await Promise.all([
    getTranslations("shell.settings.billing.renewal"),
    getFormatter(),
  ]);
  return ({ planCode, interval, currency, trialEndsAt, zone, now = new Date() }) => {
    const plan = PLAN_REGISTRY.plans.find((p) => p.code === planCode);
    if (plan === undefined || plan.stripe === null) return null;
    const list = (plan.prices as Readonly<Record<string, PlanPrice | undefined>>)[currency];
    const amountMinor = interval === "Annual" ? list?.annualMinor : list?.monthlyMinor;
    if (amountMinor === null || amountMinor === undefined) return null;
    const price = format.number(amountMinor / 100, {
      style: "currency",
      currency,
      maximumFractionDigits: amountMinor % 100 === 0 ? 0 : 2,
    });
    const nextChargeOn = firstChargeOn(
      stripeTrialEnd(trialEndsAt ?? undefined, now),
      (ms) => dateIn(new Date(ms), zone),
      now,
    );
    const values = {
      plan: t(`planNames.${plan.code}` as never),
      price,
      currency,
      date: format.dateTime(new Date(`${nextChargeOn}T12:00:00Z`), {
        dateStyle: "long",
        timeZone: "UTC",
      }),
    };
    const statement =
      interval === "Annual" ? t("statementAnnual", values) : t("statementMonthly", values);
    return {
      planCode,
      interval,
      currency,
      amountMinor,
      price,
      nextChargeOn,
      statement,
      hash: createHash("sha256").update(statement).digest("hex"),
    };
  };
}
