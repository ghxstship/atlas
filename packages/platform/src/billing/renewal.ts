/**
 * The renewal terms an Owner agrees to before paying (ADR 0161, migration 6811). Atlas words the statement from the i18n
 * catalog, in the Owner's language, and records it word for word with this version. Bump the version whenever the wording
 * in `shell.settings.billing.renewal` changes: apps/atlas/test/renewal-terms.test.ts fails until it does.
 */
export const RENEWAL_TERMS_VERSION = "2026-11-06";

/** Stripe Checkout's limit on custom_text.submit.message. */
export const CHECKOUT_MESSAGE_MAX = 1200;

/** What Atlas records with a consent, and shows again on Stripe's own page. */
export interface RenewalConsent {
  /** The price of each term in `currency`, the plan's list price. */
  readonly amountMinor: number;
  /** The currency Checkout is told to charge, so the statement and the charge cannot differ. */
  readonly currency: string;
  /** The first charge date as `YYYY-MM-DD`. */
  readonly nextChargeOn: string;
  readonly textVersion: string;
  readonly locale: string;
  readonly statement: string;
  /** What the Owner typed to initial an annual plan's terms; null on a monthly plan. */
  readonly initials: string | null;
}

/**
 * The first charge date on the org's calendar: today, or the last day of a trial Checkout will carry over. A remainder too
 * short for Stripe to carry is charged today, so the date always matches what Checkout does (stripeTrialEnd).
 */
export function firstChargeOn(
  trialCarriedUntil: number | undefined,
  dayOf: (epochMs: number) => string,
  now: Date = new Date(),
): string {
  return dayOf(trialCarriedUntil === undefined ? now.getTime() : trialCarriedUntil * 1000);
}
