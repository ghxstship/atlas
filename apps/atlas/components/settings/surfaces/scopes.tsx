import { listMembers, listWorkspaces, type Member } from "@xos/data";
import { getTeam, listWorkspaceMembershipIds } from "@xos/data/org-setup";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { requireNode } from "@/lib/shell/require-node";
import { WorkspaceOverridesPanel } from "../contributions/a30";
import { formatters, P, Quiet, Rows, Section, TextLink, type Formatters } from "./kit";

/**
 * Workspace and team settings pages (A86, RRR-131; Section 4.5.6 "short pages holding only the settings their
 * scope can override"; ADR 0006 amendment of 2026-10-21). Each looks its row up and answers 404 when it is not
 * the org's, as requireNode leaves page-resolved parameters to the page.
 */

type Params = Readonly<Record<string, string>>;

function memberRows(f: Formatters, members: readonly Member[]) {
  return members.map((m) => ({
    id: m.membershipId,
    title: m.fullName ?? f.t(`${P}.someone`),
    meta: [
      m.roles.map((r) => (r.system ? f.t(`shell.roles.${r.code}`) : (r.name ?? r.code))).join(", "),
    ],
  }));
}

export async function WorkspaceSettingsPage({ params }: { params: Params }) {
  const ctx = await requireNode("settings.workspaces.workspace", params);
  const [f, workspaces, members] = await Promise.all([
    formatters(ctx),
    listWorkspaces(ctx.viewer.db, ctx.org.id),
    listMembers(ctx.viewer.db, ctx.org.id),
  ]);
  const workspace = workspaces.ok
    ? workspaces.data.find((w) => w.slug === params["workspaceSlug"])
    : undefined;
  if (!workspace) notFound();
  const ids = await listWorkspaceMembershipIds(ctx.viewer.db, workspace.id);
  const inWorkspace =
    members.ok && ids.ok ? members.data.filter((m) => ids.data.includes(m.membershipId)) : [];
  return (
    <>
      <PageHeader title={workspace.name} />
      <p className="m-0 text-text-13 text-text-secondary">
        {f.t("settings.descriptions.workspace")}
      </p>
      <WorkspaceOverridesPanel ctx={ctx} params={params} />
      <Section id="workspace-members" title={f.t(`${P}.workspace.members`)}>
        {inWorkspace.length === 0 ? (
          <Quiet>{f.t(`${P}.workspace.noMembers`)}</Quiet>
        ) : (
          <Rows label={f.t(`${P}.workspace.members`)} rows={memberRows(f, inWorkspace)} />
        )}
      </Section>
      <TextLink href={`/${ctx.org.slug}/settings/workspaces`}>
        {f.t(`${P}.workspace.back`)}
      </TextLink>
    </>
  );
}

export async function TeamSettingsPage({ params }: { params: Params }) {
  const ctx = await requireNode("settings.teams.team", params);
  const teamId = params["teamId"] ?? "";
  const [f, team, members] = await Promise.all([
    formatters(ctx),
    getTeam(ctx.viewer.db, ctx.org.id, teamId),
    listMembers(ctx.viewer.db, ctx.org.id),
  ]);
  if (!team.ok) notFound();
  const onTeam = members.ok
    ? members.data.filter((m) => team.data.membershipIds.includes(m.membershipId))
    : [];
  return (
    <>
      <PageHeader title={team.data.name} />
      <p className="m-0 text-text-13 text-text-secondary">
        {team.data.description ?? f.t("settings.descriptions.team")}
      </p>
      <Section id="team-members" title={f.t(`${P}.team.members`)}>
        {onTeam.length === 0 ? (
          <Quiet>{f.t(`${P}.team.noMembers`)}</Quiet>
        ) : (
          <Rows label={f.t(`${P}.team.members`)} rows={memberRows(f, onTeam)} />
        )}
      </Section>
      <Section id="team-settings" title={f.t(`${P}.team.settings`)}>
        <Quiet>{f.t(`${P}.team.settingsNone`)}</Quiet>
      </Section>
      <TextLink href={`/${ctx.org.slug}/settings/teams`}>{f.t(`${P}.team.back`)}</TextLink>
    </>
  );
}
