import "server-only";
import { dateIn } from "@xos/data/calendar";
import { firstChargeOn, stripeTrialEnd } from "@xos/platform/billing";
import { createHash } from "node:crypto";
import { getFormatter, getTranslations } from "next-intl/server";
import { PLANS } from "@/lib/plans.generated";

/**
 * The renewal terms of a paid plan (ADR 0156): the one statement the Owner sees before Checkout, agrees to, and has
 * recorded word for word, and that Stripe's page repeats. The page and the server action word it from the same inputs, and
 * the action compares hashes, so what is recorded is exactly what was on the screen.
 */
export interface RenewalTerms {
  readonly planCode: string;
  readonly interval: "Monthly" | "Annual";
  readonly amountMinor: number;
  readonly price: string;
  readonly nextChargeOn: string;
  readonly statement: string;
  readonly hash: string;
}

export type RenewalWording = (input: {
  readonly planCode: string;
  readonly interval: "Monthly" | "Annual";
  readonly trialEndsAt: string | null;
  readonly zone: string | null;
  readonly now?: Date;
}) => RenewalTerms | null;

/** The wording function in the person's language. Null for a plan sold by quote or free. */
export async function renewalWording(): Promise<RenewalWording> {
  const [t, format] = await Promise.all([
    getTranslations("shell.settings.billing.renewal"),
    getFormatter(),
  ]);
  return ({ planCode, interval, trialEndsAt, zone, now = new Date() }) => {
    const plan = PLANS.find((p) => p.code === planCode);
    const amountMinor = interval === "Annual" ? plan?.usdAnnualMinor : plan?.usdMonthlyMinor;
    if (!plan?.selfServe || amountMinor === null || amountMinor === undefined) return null;
    const price = format.number(amountMinor / 100, {
      style: "currency",
      currency: "USD",
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
      amountMinor,
      price,
      nextChargeOn,
      statement,
      hash: createHash("sha256").update(statement).digest("hex"),
    };
  };
}
