import { listGroups } from "@xos/data/workforce-chat";
import { listHelpDeskTeams, HELP_DESK_TEAM_KINDS } from "@xos/data/workforce-help-desk";
import { ActionButton, EntityForm, ErrorPanel, KitLink } from "@/components/collection-kit/kit";
import { REFUSALS, memberOptions, orgPickers, workforceCopy } from "@/components/workforce/shared";
import {
  addTeamMemberAction,
  archiveTeamAction,
  createTeamAction,
  removeTeamMemberAction,
} from "@/lib/workforce/actions";
import { nodeHref } from "@/lib/shell/sitemap";
import type { SettingsContribution, SettingsPanelProps } from "./types";

/**
 * A29's settings panels (Section 4.9, ADR 0021 item 7):
 *   Settings, Communication      the org's group spaces, with a link to manage them in People, Groups
 *                                (read receipts and the feed defaults are registry settings above)
 *   Settings, Help and support   help desk teams: their kind, first response target and members
 */

function Heading({ id, title, description }: { id: string; title: string; description: string }) {
  return (
    <header className="flex flex-col gap-4">
      <h2 id={id} className="m-0 text-heading-16 font-semibold">
        {title}
      </h2>
      <p className="m-0 text-text-secondary">{description}</p>
    </header>
  );
}

async function GroupsPanel({ ctx }: SettingsPanelProps) {
  const [t, groups] = await Promise.all([workforceCopy(), listGroups(ctx.viewer.db, ctx.org.id)]);
  const href = nodeHref("people.groups", { org: ctx.org.slug }) ?? "/";
  return (
    <section aria-labelledby="workforce-groups-heading" className="flex flex-col gap-12">
      <Heading
        id="workforce-groups-heading"
        title={t("settingsPanels.groupsTitle")}
        description={t("settingsPanels.groupsDescription")}
      />
      {!groups.ok ? (
        <ErrorPanel what={t("groups.what")} />
      ) : groups.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("settingsPanels.noGroups")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-4 p-0 text-text-13">
          {groups.data.map((g) => (
            <li key={g.id}>
              {t("settingsPanels.groupLine", {
                name: g.name,
                kind: t(`groups.kinds.${g.kind}`),
                count: g.memberCount,
              })}
            </li>
          ))}
        </ul>
      )}
      <div>
        <KitLink href={href}>{t("settingsPanels.manageGroups")}</KitLink>
      </div>
    </section>
  );
}

async function HelpDeskTeamsPanel({ ctx }: SettingsPanelProps) {
  const [t, teams, pickers] = await Promise.all([
    workforceCopy(),
    listHelpDeskTeams(ctx.viewer.db, ctx.org.id),
    orgPickers(ctx),
  ]);
  const canManage = ctx.capabilities.has("org.help.write");
  return (
    <section aria-labelledby="workforce-help-desk-heading" className="flex flex-col gap-12">
      <Heading
        id="workforce-help-desk-heading"
        title={t("settingsPanels.teamsTitle")}
        description={t("settingsPanels.teamsDescription")}
      />
      {!teams.ok ? (
        <ErrorPanel what={t("helpDesk.what")} />
      ) : teams.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("settingsPanels.noTeams")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-12 p-0 text-text-13">
          {teams.data.map((team) => (
            <li
              key={team.id}
              className="flex flex-col gap-8 rounded-card border border-border-subtle p-12"
            >
              <div className="flex flex-wrap items-center justify-between gap-8">
                <strong className="font-medium">
                  {t("settingsPanels.teamLine", {
                    name: team.name,
                    kind: t(`settingsPanels.kinds.${team.kind}`),
                    hours: team.firstResponseHours,
                  })}
                </strong>
                {team.archivedAt ? (
                  <span className="text-text-12 text-text-secondary">
                    {t("settingsPanels.archived")}
                  </span>
                ) : canManage ? (
                  <ActionButton
                    action={archiveTeamAction}
                    hidden={{ org: ctx.org.slug, id: team.id }}
                    label={t("settingsPanels.archive")}
                    variant="danger"
                    confirm={{
                      title: t("settingsPanels.archiveTitle", { name: team.name }),
                      body: t("settingsPanels.archiveBody"),
                    }}
                    refusals={REFUSALS}
                  />
                ) : null}
              </div>
              {team.members.length === 0 ? (
                <p className="m-0 text-text-secondary">{t("settingsPanels.noMembers")}</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-4 p-0">
                  {team.members.map((m) => (
                    <li key={m.id} className="flex flex-wrap items-center gap-8">
                      <span>{m.name ?? t("someone")}</span>
                      {canManage && !team.archivedAt ? (
                        <ActionButton
                          action={removeTeamMemberAction}
                          hidden={{ org: ctx.org.slug, id: m.id }}
                          label={t("settingsPanels.remove")}
                          refusals={REFUSALS}
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {canManage && !team.archivedAt ? (
                <EntityForm
                  id={`team-member-${team.id}`}
                  action={addTeamMemberAction}
                  hidden={{ org: ctx.org.slug, id: team.id }}
                  refusals={REFUSALS}
                  submitLabel={t("settingsPanels.addMember")}
                  fields={[
                    {
                      kind: "select",
                      name: "membershipId",
                      label: t("settingsPanels.member"),
                      required: true,
                      blankLabel: t("feed.pickOne"),
                      options: memberOptions(pickers.members).filter(
                        (o) => !team.members.some((m) => m.membershipId === o.value),
                      ),
                    },
                  ]}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canManage ? (
        <EntityForm
          id="team-create"
          action={createTeamAction}
          hidden={{ org: ctx.org.slug }}
          refusals={REFUSALS}
          submitLabel={t("settingsPanels.createTeam")}
          fields={[
            { kind: "text", name: "name", label: t("settingsPanels.teamName"), required: true },
            {
              kind: "select",
              name: "kind",
              label: t("settingsPanels.teamKind"),
              required: true,
              defaultValue: "Operations",
              options: HELP_DESK_TEAM_KINDS.map((k) => ({
                value: k,
                label: t(`settingsPanels.kinds.${k}`),
              })),
            },
            {
              kind: "number",
              name: "hours",
              label: t("settingsPanels.hours"),
              required: true,
              defaultValue: "8",
              help: t("settingsPanels.hoursHelp"),
            },
            {
              kind: "textarea",
              name: "description",
              label: t("settingsPanels.teamDescription"),
              rows: 2,
            },
          ]}
        />
      ) : null}
    </section>
  );
}

export const contributions: readonly SettingsContribution[] = [
  { node: "settings.communication", order: 20, Panel: GroupsPanel },
  { node: "settings.help-and-support", order: 30, Panel: HelpDeskTeamsPanel },
];
