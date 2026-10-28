/**
 * One-tap email actions (A127, ADR 0106): the actions a notification email links to, in the order its buttons show.
 * Kept apart from the templates so a sender that only builds the links never loads React Email.
 */
export const EMAIL_ACTIONS = ["approve", "accept", "reject"] as const;
export type EmailActionName = (typeof EMAIL_ACTIONS)[number];

/** One action button: the signed, single-use link to its confirm page. */
export interface EmailAction {
  readonly action: EmailActionName;
  readonly url: string;
}

export function isEmailActionName(value: unknown): value is EmailActionName {
  return typeof value === "string" && (EMAIL_ACTIONS as readonly string[]).includes(value);
}
