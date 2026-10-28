import { listAccountMembers, listMyAccounts } from "@xos/data/gateway";
import {
  listAccountTalent,
  listEngagementAssignments,
  listEngagementRoster,
  listRoleOptions,
  type RosterEntry,
} from "@xos/data/roster";
import { ActionButton } from "@/components/actions/action-button";
import { RegionError, Section } from "@/components/page/page";
import {
  reissueRosterInvitationAction,
  submitRosterAction,
  unassignEngagementMemberAction,
  withdrawRosterEntryAction,
} from "@/lib/actions/roster";
import { formatDateTime } from "@/lib/format";
import { enumLabelKey } from "@/lib/shell/translate";
import { toneFor } from "@/lib/states";
import {
  AddFromTeamForm,
  AssignMemberForm,
  EditRosterEntryForm,
  InviteToRosterForm,
} from "./roster-forms";
import { RosterProfileButton } from "./roster-profile";
import { RowList, TabEmpty } from "./rows";
import type { TabProps } from "./tab-context";

/**
 * The Crew tab (R4, ADR 0100 and 0101): the people a party puts on an engagement. A roster manager
 * (the engaged person of an artist engagement, the account's Owner or Admin, an Advancing Lead or an
 * Advance representative) adds people from the team or invites them by email, submits the roster for
 * the producing org's review and withdraws entries; each row shows the review state, the person's own
 * answer and what they share. View profile reads the person's details once, logged, in a dialog.
 */
export async function CrewTab({ view, t, locale }: TabProps) {
  const { engagement } = view;
  const [roster, talent, roles] = await Promise.all([
    listEngagementRoster(view.ctx.db, engagement.id),
    listAccountTalent(view.ctx.db, engagement.accountId),
    listRoleOptions(view.ctx.db, engagement.roleCode),
  ]);
  if (!roster.ok || !talent.ok || !roles.ok) return <RegionError />;
  const entries = roster.data.filter((e) => e.entryState !== "Withdrawn");
  const onRoster = new Set(entries.map((e) => e.personId).filter(Boolean));
  const roleOptions = roles.data.map((r) => ({
    value: r.roleCode,
    label: `${r.jobTitle} (${r.roleCode})`,
  }));
  const talentOptions = talent.data
    .filter((p) => !onRoster.has(p.personId) && p.personId !== engagement.personId)
    .map((p) => ({
      value: p.personId,
      label:
        p.source === "Represented Artist"
          ? t("gateway.engagement.crew.representedArtist", { name: p.fullName })
          : p.fullName,
    }));
  const timeZone = engagement.projectTimeZone;
  const toSubmit = entries.filter(
    (e) =>
      !e.isSelf && e.personId !== null && (e.entryState === "Draft" || e.entryState === "Returned"),
  );
  const local = (iso: string | null) =>
    iso
      ? new Intl.DateTimeFormat("sv-SE", {
          timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        })
          .format(new Date(iso))
          .replace(" ", "T")
      : "";
  const arrival = (e: RosterEntry) =>
    e.arrivalStartsAt && e.arrivalEndsAt && e.arrivalTimeZone
      ? t("gateway.engagement.crew.arrival", {
          start: formatDateTime(locale, e.arrivalStartsAt, e.arrivalTimeZone),
          end: formatDateTime(locale, e.arrivalEndsAt, e.arrivalTimeZone),
        })
      : t("gateway.engagement.crew.noArrival");
  return (
    <div className="flex flex-col gap-16">
      <div className="flex flex-wrap items-center justify-between gap-12">
        <p className="m-0 max-w-[60ch] text-text-14 text-text-secondary">
          {t("gateway.engagement.crew.sentence")}
        </p>
        {toSubmit.length > 0 ? (
          <ActionButton
            action={submitRosterAction.bind(null, engagement.id)}
            label={t("gateway.engagement.crew.submit", { n: toSubmit.length })}
            variant="primary"
            done={t("gateway.engagement.crew.submitted")}
          />
        ) : null}
      </div>
      {entries.length === 0 ? (
        <TabEmpty
          icon="Users"
          sentence={t("gateway.engagement.crew.empty")}
          actionLabel={t("gateway.engagement.crew.emptyAction")}
          href="#crew-add"
        />
      ) : (
        <RowList
          label={t("gateway.engagement.crew.listLabel")}
          items={entries.map((e) => {
            const title =
              e.fullName ?? e.invitedEmail ?? t("gateway.engagement.crew.invitedSomeone");
            const editable = e.isSelf || e.entryState === "Draft" || e.entryState === "Returned";
            return {
              id: e.id,
              title,
              meta: [
                e.isSelf ? t("gateway.engagement.crew.self") : null,
                e.jobTitle,
                arrival(e),
                e.personId === null
                  ? t("gateway.engagement.crew.invitation", {
                      date: e.invitationExpiresAt
                        ? formatDateTime(locale, e.invitationExpiresAt)
                        : "",
                    })
                  : t(enumLabelKey("rosterPersonResponse", e.personResponse)),
                e.shareCategories.length > 0
                  ? t("gateway.engagement.crew.sharing", { n: e.shareCategories.length })
                  : t("gateway.engagement.crew.notSharing"),
                e.entryState === "Returned" && e.returnReason
                  ? t("gateway.engagement.crew.returned", { reason: e.returnReason })
                  : null,
              ],
              tag: {
                label: t(enumLabelKey("rosterEntryState", e.entryState)),
                tone: toneFor(e.entryState),
              },
              action: (
                <span className="flex flex-wrap gap-8">
                  {e.personId !== null && e.personId !== view.ctx.personId ? (
                    <RosterProfileButton rosterEntryId={e.id} name={title} />
                  ) : null}
                  {e.personId === null && !e.isSelf ? (
                    <ActionButton
                      action={reissueRosterInvitationAction.bind(null, e.id)}
                      label={t("gateway.engagement.crew.reissue")}
                      done={t("gateway.engagement.crew.reissued")}
                    />
                  ) : null}
                  {!e.isSelf ? (
                    <ActionButton
                      action={withdrawRosterEntryAction.bind(null, e.id, "")}
                      label={t("gateway.engagement.crew.withdraw")}
                      variant="ghost"
                    />
                  ) : null}
                </span>
              ),
              detail: editable ? (
                <details>
                  <summary className="cursor-pointer text-text-13 text-text-link">
                    {t("gateway.engagement.crew.edit")}
                  </summary>
                  <EditRosterEntryForm
                    rosterEntryId={e.id}
                    roles={roleOptions}
                    timeZone={timeZone}
                    roleCode={e.roleCode}
                    startsAt={local(e.arrivalStartsAt)}
                    endsAt={local(e.arrivalEndsAt)}
                    entryTimeZone={e.arrivalTimeZone}
                  />
                </details>
              ) : undefined,
            };
          })}
        />
      )}
      <Section id="crew-add" title={t("gateway.engagement.crew.addTitle")}>
        {talentOptions.length > 0 ? (
          <AddFromTeamForm
            engagementId={engagement.id}
            talent={talentOptions}
            roles={roleOptions}
            timeZone={timeZone}
          />
        ) : (
          <p className="m-0 text-text-14 text-text-secondary">
            {t("gateway.engagement.crew.noTalent")}
          </p>
        )}
      </Section>
      <Section id="crew-invite" title={t("gateway.engagement.crew.inviteTitle")}>
        <InviteToRosterForm engagementId={engagement.id} roles={roleOptions} timeZone={timeZone} />
      </Section>
    </div>
  );
}

/**
 * Account team on the engagement Overview (R4, owner decision 6): for the supplying account's Owner
 * and Admin, the members assigned to the engagement with Remove, and an Assign form for a confirmed
 * member with the Advancing Lead or Member duty. An Account Member reaches only what they are
 * assigned, so nothing renders for anyone else.
 */
export async function AccountTeamSection({ view, t }: Pick<TabProps, "view" | "t">) {
  const accountId = view.engagement.accountId;
  if (!accountId) return null;
  const accounts = await listMyAccounts(view.ctx.db);
  const mine = accounts.ok ? accounts.data.find((a) => a.id === accountId) : undefined;
  if (!mine || !mine.roles.some((r) => r === "Account Owner" || r === "Account Admin")) return null;
  const [assignments, members] = await Promise.all([
    listEngagementAssignments(view.ctx.db, view.engagement.id),
    listAccountMembers(view.ctx.db, accountId),
  ]);
  if (!assignments.ok || !members.ok) return <RegionError />;
  const assigned = new Set(assignments.data.map((a) => a.accountMembershipId));
  const candidates = members.data
    .filter(
      (m) =>
        m.acceptedAt !== null && m.personId !== view.ctx.personId && !assigned.has(m.membershipId),
    )
    .map((m) => ({ value: m.membershipId, label: m.fullName ?? "" }));
  return (
    <Section title={t("gateway.engagement.accountTeam.title")}>
      <p className="m-0 text-text-14 text-text-secondary">
        {t("gateway.engagement.accountTeam.sentence")}
      </p>
      {assignments.data.length > 0 ? (
        <RowList
          label={t("gateway.engagement.accountTeam.title")}
          items={assignments.data.map((a) => ({
            id: a.id,
            title: a.fullName,
            tag: {
              label: t(enumLabelKey("accountEngagementDuty", a.duty)),
              tone: "neutral" as const,
            },
            action: (
              <ActionButton
                action={unassignEngagementMemberAction.bind(null, a.id)}
                label={t("gateway.engagement.accountTeam.remove")}
                variant="ghost"
              />
            ),
          }))}
        />
      ) : (
        <p className="m-0 text-text-14 text-text-secondary">
          {t("gateway.engagement.accountTeam.none")}
        </p>
      )}
      {candidates.length > 0 ? (
        <AssignMemberForm engagementId={view.engagement.id} members={candidates} />
      ) : null}
    </Section>
  );
}
