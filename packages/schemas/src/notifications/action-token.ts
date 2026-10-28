/** A one-tap email action token (ADR 0086): a nonce and its signature, minted and verified only in the database. */
export const ACTION_TOKEN = /^xact_[0-9a-f]{48}\.[0-9a-f]{32}$/;

/** The confirm page, in Atlas and Gateway. */
export const ACTION_PATH = "/auth/act";

export function isActionToken(value: unknown): value is string {
  return typeof value === "string" && ACTION_TOKEN.test(value);
}
