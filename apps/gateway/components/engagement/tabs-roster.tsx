import { listAccountMembers, listMyAccounts } from "@xos/data/gateway";
import { listEngagementAllocations, listRequestableItems } from "@xos/data/gateway-allocations";
import {
  listAccountTalent,
  listEngagementAssignments,
  listEngagementRoster,
  listRoleOptions,
  rosterLocked,
  type RosterEntry,
  rosterCopySources,
} from "@xos/data/roster";
import { listRosterFactStatus, rosterFactChip } from "@xos/data/roster-facts";
import dynamic from "next/dynamic";
import { ActionButton } from "@/components/actions/action-button";
import { RegionError, Section } from "@/components/page/page";
import { Button, InlineAlert, StateChip } from "@/components/ui";
import {
  reissueRosterInvitationAction,
  submitRosterAction,
  unassignEngagementMemberAction,
  withdrawRosterEntryAction,
} from "@/lib/actions/roster";
import { formatDate, formatDateTime } from "@/lib/format";
import { enumLabelKey } from "@/lib/shell/translate";
import { toneFor } from "@/lib/states";
import {
  AddFromTeamForm,
  AssignMemberForm,
  EditRosterEntryForm,
  InviteToRosterForm,
} from "./roster-forms";
import { RosterFactsButton } from "@/components/roster/roster-facts-button";
import { chipState } from "@/lib/roster-facts-steps";
import { CrewAllocations, EntryItems } from "./crew-allocations";
import { RosterProfileButton } from "./roster-profile";
import { RowList, TabEmpty } from "./rows";
import type { TabProps } from "./tab-context";

// Withdrawing someone is final (their invitation, share and consent end with it), so it is confirmed in a
// dialog whose code loads on demand.
/** Reuse a roster from a past event (B14) loads only for a roster manager who has a past roster to reuse. */
const RosterCopyPanel = dynamic(() => import("./roster-copy").then((m) => m.RosterCopyPanel));

const ConfirmButton = dynamic(() =>
  import("@/components/actions/confirm-button").then((m) => m.ConfirmButton),
);

/**
 * The Crew tab (R4, ADR 0100 and 0101): the people a party puts on an engagement. A roster manager
 * (the engaged person of an artist engagement, the account's Owner or Admin, an Advancing Lead or an
 * Advance representative) adds people from the team or invites them by email, submits the roster for
 * the producing org's review and withdraws entries; each row shows the review state, the person's own
 * answer and what they share. View profile reads the person's details once, logged, in a dialog.
 *
 * R5 adds the project facts: each row's Travel, Uniform and Vehicle chips read presence only (not logged), and
 * Project details opens a drawer that reads the values once, logged. A names lock set by the producing org (G-142)
 * shows as a banner; after it passes, Add, Invite and Submit of new names are closed, and Returned entries stay
 * editable and resubmittable.
 *
 * R8 adds what the party asks for and shares out: the pool, each person's items with their computed status,
 * Request item, and Assign from pool for several people at once (crew-allocations.tsx).
 */
export async function CrewTab({ view, t, locale }: TabProps) {
  const { engagement } = view;
  const [roster, talent, roles, factStatus, allocations, requestable, copySources] =
    await Promise.all([
      listEngagementRoster(view.ctx.db, engagement.id),
      listAccountTalent(view.ctx.db, engagement.accountId),
      listRoleOptions(view.ctx.db, engagement.roleCode),
      listRosterFactStatus(view.ctx.db, engagement.id),
      listEngagementAllocations(view.ctx.db, engagement.id),
      listRequestableItems(view.ctx.db, engagement.id),
      // B14 (3037): refused (42501) for anyone who does not manage this roster, who then sees no reuse.
      rosterCopySources(view.ctx.db, engagement.id),
    ]);
  const reusable = copySources.ok ? copySources.data.filter((s) => s.entries > 0) : [];
  if (!roster.ok || !talent.ok || !roles.ok || !factStatus.ok || !allocations.ok || !requestable.ok)
    return <RegionError />;
  const statusOf = new Map(factStatus.data.map((s) => [s.rosterEntryId, s]));
  const locked = rosterLocked(engagement.rosterLocksAt);
  const lockDate = engagement.rosterLocksAt
    ? formatDateTime(locale, engagement.rosterLocksAt, engagement.projectTimeZone)
    : "";
  const lockedSentence = t("gateway.engagement.crew.lockedOn", {
    date: lockDate,
    orgName: engagement.orgName,
  });
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
  // Under a names lock only Returned entries go back for review (2656); Draft names wait for the lock to move.
  const toSubmit = entries.filter(
    (e) =>
      !e.isSelf &&
      e.personId !== null &&
      (e.entryState === "Returned" || (e.entryState === "Draft" && !locked)),
  );
  // Drafts the lock holds back: with nothing else to submit, Submit stays on screen, disabled, with the lock sentence.
  const held = locked
    ? entries.filter((e) => !e.isSelf && e.personId !== null && e.entryState === "Draft").length
    : 0;
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
      {engagement.rosterLocksAt ? (
        <InlineAlert tone={locked ? "warning" : "info"}>
          {locked ? lockedSentence : t("gateway.engagement.crew.locksOn", { date: lockDate })}
        </InlineAlert>
      ) : null}
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
        ) : held > 0 ? (
          <span className="inline-flex flex-col items-start gap-4">
            <Button variant="primary" size="sm" disabled aria-describedby="crew-submit-locked">
              {t("gateway.engagement.crew.submit", { n: held })}
            </Button>
            <span id="crew-submit-locked" className="text-text-12 text-text-secondary">
              {lockedSentence}
            </span>
          </span>
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
            const editable =
              e.isSelf || e.entryState === "Returned" || (e.entryState === "Draft" && !locked);
            const status = statusOf.get(e.id);
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
                <span className="flex flex-wrap items-center gap-8">
                  {status
                    ? (["travel", "uniform", "vehicle"] as const).map((kind) => {
                        const chip = rosterFactChip(status, kind);
                        return (
                          <StateChip
                            key={kind}
                            compact
                            state={chipState(chip)}
                            label={`${t(`workDetails.projectFacts.kinds.${kind}`)}: ${t(`workDetails.projectFacts.chips.${chip}`)}`}
                          />
                        );
                      })
                    : null}
                  {e.personId !== null && e.personId !== view.ctx.personId ? (
                    <RosterProfileButton rosterEntryId={e.id} name={title} />
                  ) : null}
                  {status && e.personId !== null && e.personId !== view.ctx.personId ? (
                    <RosterFactsButton
                      rosterEntryId={e.id}
                      name={title}
                      companyName={e.partyName ?? ""}
                      projectName={engagement.projectName}
                    />
                  ) : null}
                  {e.personId === null && !e.isSelf ? (
                    <ActionButton
                      action={reissueRosterInvitationAction.bind(null, e.id)}
                      label={t("gateway.engagement.crew.reissue")}
                      done={t("gateway.engagement.crew.reissued")}
                    />
                  ) : null}
                  {!e.isSelf ? (
                    <ConfirmButton
                      action={withdrawRosterEntryAction.bind(null, e.id, "")}
                      label={t("gateway.engagement.crew.withdraw")}
                      title={t("gateway.engagement.crew.withdrawTitle", { name: title })}
                      sentence={t("gateway.engagement.crew.withdrawSentence")}
                      confirm={t("gateway.engagement.crew.withdrawConfirm")}
                      cancel={t("gateway.common.cancel")}
                    />
                  ) : null}
                </span>
              ),
              detail: (
                <>
                  <EntryItems
                    allocations={allocations.data}
                    rosterEntryId={e.id}
                    t={t}
                    locale={locale}
                  />
                  {editable ? (
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
                  ) : null}
                </>
              ),
            };
          })}
        />
      )}
      <CrewAllocations
        engagementId={engagement.id}
        timeZone={timeZone}
        orgName={engagement.orgName}
        entries={entries}
        allocations={allocations.data}
        requestable={requestable.data}
        t={t}
        locale={locale}
      />
      {reusable.length > 0 && !locked ? (
        <RosterCopyPanel
          engagementId={engagement.id}
          sources={reusable}
          format={Object.fromEntries(
            reusable.map((s) => [
              s.engagementId,
              s.startsOn
                ? t("gateway.engagement.roster.copy.sourceLine", {
                    project: s.projectName,
                    date: formatDate(locale, s.startsOn),
                  })
                : s.projectName,
            ]),
          )}
        />
      ) : null}
      <Section id="crew-add" title={t("gateway.engagement.crew.addTitle")}>
        {locked ? (
          <p className="m-0 text-text-14 text-text-secondary">{lockedSentence}</p>
        ) : talentOptions.length > 0 ? (
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
        {locked ? (
          <p className="m-0 text-text-14 text-text-secondary">{lockedSentence}</p>
        ) : (
          <InviteToRosterForm
            engagementId={engagement.id}
            roles={roleOptions}
            timeZone={timeZone}
          />
        )}
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
