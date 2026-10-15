/**
 * External account roles (A04P, API parity). Granting a role goes through app.add_account_member
 * (`addAccountMember` in ./gateway.ts); removing one goes through app.remove_account_role (0710),
 * which refuses removing the last Account Owner. Callers hold no write grant on the role rows.
 */
import type { XosClient } from "./client.ts";
import { fail, ok, toDataError } from "./result.ts";
import type { Result } from "./result.ts";

/** Removes one role from an account membership (app.remove_account_role). */
export async function removeAccountRole(
  db: XosClient,
  accountMembershipRoleId: string,
): Promise<Result<null>> {
  const { error } = await db.rpc("remove_account_role", {
    p_account_membership_role_id: accountMembershipRoleId,
  });
  return error ? fail(toDataError(error)) : ok(null);
}
