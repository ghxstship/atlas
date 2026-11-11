/**
 * Whether inviting this email replaces an invitation still waiting: app.invite_member revokes the earlier one (6050),
 * so its link stops working (crawl 4.9). Emails compare trimmed and case-insensitively, as the database does.
 */
export function replacesPendingInvite(email: string, pendingEmails: readonly string[]): boolean {
  const wanted = email.trim().toLowerCase();
  return wanted !== "" && pendingEmails.some((p) => p.trim().toLowerCase() === wanted);
}
