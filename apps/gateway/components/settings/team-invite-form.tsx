"use client";

import { Input, Select } from "@xos/ui";
import { useActionState } from "react";
import { FormShell, useCopy } from "@/components/engagement/forms";
import type { FormResult } from "@/lib/actions/operations";
import { inviteAccountMemberAction } from "@/lib/actions/roster";

/**
 * Invite someone to the company account by email (R4, migration 2630). The invitation is saved and one
 * email goes to the address; the person signs in to Gateway with that address and accepts it on Home.
 * Only an Account Owner offers Account Owner; the database refuses the rest.
 */
export function TeamInviteForm({ accountId, owner }: { accountId: string; owner: boolean }) {
  const t = useCopy();
  const [state, action, pending] = useActionState<FormResult, FormData>(inviteAccountMemberAction, {});
  const roles = [
    ...(owner ? [{ value: "Account Owner", label: t("teamInvite.roleOwner") }] : []),
    { value: "Account Admin", label: t("teamInvite.roleAdmin") },
    { value: "Account Finance", label: t("teamInvite.roleFinance") },
    { value: "Account Member", label: t("teamInvite.roleMember") },
  ];
  return (
    <FormShell
      row
      state={state}
      pending={pending}
      action={action}
      submitLabel={t("teamInvite.submit")}
      doneLabel={t("teamInvite.done")}
      label={t("teamInvite.title")}
    >
      <input type="hidden" name="accountId" value={accountId} />
      <Input
        id="team-invite-email"
        name="email"
        type="email"
        required
        autoComplete="off"
        label={t("teamInvite.email")}
        help={t("teamInvite.emailHelp")}
      />
      <Select id="team-invite-role" name="role" label={t("teamInvite.role")} value="Account Member" options={roles} />
    </FormShell>
  );
}
