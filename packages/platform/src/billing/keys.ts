/**
 * Stripe key checks with no dependency, so the stripe-webhook Edge Function can tell the mode of its
 * key without loading zod for the billing environment schema (A85).
 */

/** True for test mode keys, so events from the other mode are never applied. */
export function isTestKey(key: string): boolean {
  return /^(sk|rk)_test_/.test(key);
}
