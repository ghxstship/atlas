"use client";

import { Combobox, Input, Select } from "@xos/ui";
import { useActionState, useState } from "react";
import {
  addRosterEntryAction,
  assignEngagementMemberAction,
  inviteToRosterAction,
  updateRosterEntryAction,
} from "@/lib/actions/roster";
import type { FormResult } from "@/lib/actions/operations";
import { FormShell, useCopy } from "./forms";

/**
 * Crew roster forms (R4): add someone from the team, invite an address, edit an entry, and assign an
 * account member to the engagement. Each shows at most five fields (Section 11.10: seven before More
 * fields). The arrival window is typed in the project's time zone, which the zone field defaults to.
 */

export interface Option {
  readonly value: string;
  readonly label: string;
}

/** Role, arrival start and end, and the arrival's time zone: the fields every entry form shares. */
function EntryFields({
  idPrefix,
  roles,
  timeZone,
  initial,
}: {
  idPrefix: string;
  roles: readonly Option[];
  timeZone: string;
  initial?: { roleCode: string | null; startsAt: string; endsAt: string; timeZone: string | null };
}) {
  const t = useCopy();
  const [role, setRole] = useState(initial?.roleCode ?? "");
  return (
    <>
      <input type="hidden" name="roleCode" value={role} />
      <Combobox
        label={t("roster.role")}
        placeholder={t("roster.rolePlaceholder")}
        noMatch={t("roster.roleNoMatch")}
        options={[...roles]}
        value={role}
        onChange={setRole}
      />
      <div className="flex flex-wrap gap-12">
        <Input
          id={`${idPrefix}-starts`}
          name="arrivalStartsAt"
          type="datetime-local"
          label={t("roster.arrivalStarts")}
          defaultValue={initial?.startsAt ?? ""}
        />
        <Input
          id={`${idPrefix}-ends`}
          name="arrivalEndsAt"
          type="datetime-local"
          label={t("roster.arrivalEnds")}
          defaultValue={initial?.endsAt ?? ""}
        />
      </div>
      <Input
        id={`${idPrefix}-zone`}
        name="arrivalTimeZone"
        label={t("roster.timeZone")}
        help={t("roster.timeZoneHelp")}
        defaultValue={initial?.timeZone ?? timeZone}
      />
    </>
  );
}

export function AddFromTeamForm(props: {
  engagementId: string;
  talent: readonly Option[];
  roles: readonly Option[];
  timeZone: string;
}) {
  const t = useCopy();
  const [state, action, pending] = useActionState<FormResult, FormData>(addRosterEntryAction, {});
  return (
    <FormShell
      row
      state={state}
      pending={pending}
      action={action}
      submitLabel={t("roster.add")}
      doneLabel={t("roster.added")}
      label={t("roster.addTitle")}
    >
      <input type="hidden" name="engagementId" value={props.engagementId} />
      <Select
        id="roster-add-person"
        name="personId"
        label={t("roster.person")}
        placeholder={t("roster.personPlaceholder")}
        options={[...props.talent]}
      />
      <EntryFields idPrefix="roster-add" roles={props.roles} timeZone={props.timeZone} />
    </FormShell>
  );
}

export function InviteToRosterForm(props: {
  engagementId: string;
  roles: readonly Option[];
  timeZone: string;
}) {
  const t = useCopy();
  const [state, action, pending] = useActionState<FormResult, FormData>(inviteToRosterAction, {});
  return (
    <FormShell
      row
      state={state}
      pending={pending}
      action={action}
      submitLabel={t("roster.invite")}
      doneLabel={t("roster.invited")}
      label={t("roster.inviteTitle")}
    >
      <input type="hidden" name="engagementId" value={props.engagementId} />
      <Input
        id="roster-invite-email"
        name="email"
        type="email"
        required
        autoComplete="off"
        label={t("roster.email")}
        help={t("roster.emailHelp")}
      />
      <EntryFields idPrefix="roster-invite" roles={props.roles} timeZone={props.timeZone} />
    </FormShell>
  );
}

export function EditRosterEntryForm(props: {
  rosterEntryId: string;
  roles: readonly Option[];
  timeZone: string;
  roleCode: string | null;
  startsAt: string;
  endsAt: string;
  entryTimeZone: string | null;
}) {
  const t = useCopy();
  const [state, action, pending] = useActionState<FormResult, FormData>(updateRosterEntryAction, {});
  return (
    <FormShell
      row
      state={state}
      pending={pending}
      action={action}
      submitLabel={t("roster.save")}
      doneLabel={t("roster.saved")}
      label={t("roster.editTitle")}
    >
      <input type="hidden" name="rosterEntryId" value={props.rosterEntryId} />
      <EntryFields
        idPrefix={`roster-edit-${props.rosterEntryId}`}
        roles={props.roles}
        timeZone={props.timeZone}
        initial={{
          roleCode: props.roleCode,
          startsAt: props.startsAt,
          endsAt: props.endsAt,
          timeZone: props.entryTimeZone,
        }}
      />
    </FormShell>
  );
}

export function AssignMemberForm(props: { engagementId: string; members: readonly Option[] }) {
  const t = useCopy();
  const [state, action, pending] = useActionState<FormResult, FormData>(assignEngagementMemberAction, {});
  return (
    <FormShell
      row
      state={state}
      pending={pending}
      action={action}
      submitLabel={t("accountTeam.assign")}
      doneLabel={t("accountTeam.assigned")}
      label={t("accountTeam.assignTitle")}
    >
      <input type="hidden" name="engagementId" value={props.engagementId} />
      <Select
        id="assign-member"
        name="accountMembershipId"
        label={t("accountTeam.member")}
        placeholder={t("accountTeam.memberPlaceholder")}
        options={[...props.members]}
      />
      <Select
        id="assign-duty"
        name="duty"
        label={t("accountTeam.duty")}
        value="Member"
        options={[
          { value: "Member", label: t("accountTeam.dutyMember") },
          { value: "Advancing Lead", label: t("accountTeam.dutyLead") },
        ]}
      />
    </FormShell>
  );
}
