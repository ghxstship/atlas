/**
 * Who removes whom from a company account (Section 4.4.1, crawl 4.9). An Account Owner or Admin
 * removes other members, but only an Account Owner removes a member who holds Account Owner, as
 * only an Owner grants or removes the Owner role (app.end_account_membership, 904110701).
 */
export function canRemoveMember(input: {
  readonly actingRoles: readonly string[];
  readonly personId: string;
  readonly member: { readonly personId: string; readonly roles: readonly string[] };
}): boolean {
  const { actingRoles, personId, member } = input;
  const owner = actingRoles.includes("Account Owner");
  if (!owner && !actingRoles.includes("Account Admin")) return false;
  if (member.personId === personId) return false;
  return owner || !member.roles.includes("Account Owner");
}

/**
 * Whether the acting member edits the company profile: an Account Owner or Admin, as
 * private.can_edit_org_profile (0860). Finance and Members read it.
 */
export function canEditCompanyProfile(actingRoles: readonly string[]): boolean {
  return actingRoles.includes("Account Owner") || actingRoles.includes("Account Admin");
}
