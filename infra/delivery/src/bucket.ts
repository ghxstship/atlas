/**
 * Deterministic rollout buckets. An org's bucket for a flag is the first 32 bits of
 * SHA-256("<flag_key>:<org_id>") modulo 10,000 (basis points). The same org lands in the same
 * bucket for a flag on every run, so a cohort only grows from 5 to 25 to 100 percent, and
 * different flags pick independent cohorts.
 *
 * `bucketSql` computes the identical value inside Postgres with the built-in sha256, so an
 * operator can select a cohort with SQL alone; the tests pin both to shared vectors.
 */

export const BASIS_POINTS = 10_000;

export async function rolloutBucket(flagKey: string, orgId: string): Promise<number> {
  const bytes = new TextEncoder().encode(`${flagKey}:${orgId.toLowerCase()}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const first =
    ((digest[0] ?? 0) * 2 ** 24 +
      (digest[1] ?? 0) * 2 ** 16 +
      (digest[2] ?? 0) * 2 ** 8 +
      (digest[3] ?? 0)) >>>
    0;
  return first % BASIS_POINTS;
}

/** True when the org is inside a rollout of `percent` (0 to 100, up to two decimals). */
export async function inRollout(flagKey: string, orgId: string, percent: number): Promise<boolean> {
  return (await rolloutBucket(flagKey, orgId)) < Math.round(percent * 100);
}

/** SQL expression for the bucket of `org_id_sql` under the flag `flag_key_sql` (both SQL expressions). */
export function bucketSql(flagKeySql: string, orgIdSql: string): string {
  return `(('x' || substr(encode(sha256(convert_to(${flagKeySql} || ':' || ${orgIdSql}::text, 'UTF8')), 'hex'), 1, 8))::bit(32)::bigint % ${BASIS_POINTS})`;
}
