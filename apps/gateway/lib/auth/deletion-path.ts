// Its own module, so the proxy reads it without the legal acceptance code (merge train 11).

/** Settings, Account: where a person deletes their account (Delete Your Account, Section 1). */
export const ACCOUNT_DELETION_PATH = "/settings/account";

/**
 * True when `next` is the account deletion page. The terms step lets it through unaccepted: deleting an
 * account never waits on accepting anything (Worker Terms 13), so a person who declines can still leave.
 */
export function skipsTermsStep(next: string): boolean {
  const path = next.split(/[?#]/, 1)[0] ?? "";
  return path === ACCOUNT_DELETION_PATH || path.startsWith(`${ACCOUNT_DELETION_PATH}/`);
}
