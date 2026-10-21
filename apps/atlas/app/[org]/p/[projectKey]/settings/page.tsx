import { listMembers } from "@xos/data";
import { listProjectMembers, PROJECT_ROLE_ORDER } from "@xos/data/projects";
import { isNodeVisible } from "@xos/ia";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ProjectAccess } from "@/components/projects/project-access";
import { ProjectInboxSettings } from "@/components/projects/project-inbox";
import { ProjectSettings } from "@/components/projects/project-settings";
import { projectFormOptions } from "@/components/projects/projects-page";
import { PageHeader } from "@/components/projects/ui";
import { requireNode } from "@/lib/shell/require-node";
import { getProjectContextFor } from "@/lib/projects/context";
import { loadTransitions, must } from "@/lib/projects/loaders";
import { nodeHref, sitemap } from "@/lib/shell/sitemap";

/**
 * Project Settings (Section 4.5.4): key, jurisdiction, region, tier, members, lifecycle, archive, and
 * (A52) extra project roles per member and the partner orgs the project is shared with, and (A84)
 * the project inbox address (Section 4.6.5).
 */
export default async function SettingsPage({
  params,
}: PageProps<"/[org]/p/[projectKey]/settings">) {
  const routeParams = await params;
  await requireNode("project.settings", routeParams);
  const ctx = await getProjectContextFor(routeParams);
  if (!ctx) notFound();
  const db = ctx.org.viewer.db;
  const t = await getTranslations("projects");
  const canMembers = ctx.capabilities.has("projects.members.manage");
  const [options, members, orgMembers, moves] = await Promise.all([
    projectFormOptions(ctx.org),
    listProjectMembers(db, ctx.project.id),
    canMembers ? listMembers(db, ctx.org.org.id) : Promise.resolve({ ok: true as const, data: [] }),
    loadTransitions(ctx),
  ]);
  const current = must(members, "project members");
  const onProject = new Set(current.map((m) => m.membershipId));
  const me = ctx.org.viewer.person?.id;
  const candidates = must(orgMembers, "members")
    .filter((m) => !onProject.has(m.membershipId) && m.personId !== me)
    .map((m) => ({ value: m.membershipId, label: m.fullName ?? m.membershipId }));
  return (
    <>
      <PageHeader title={t("settings.title")} />
      <ProjectSettings
        org={ctx.org.org.slug}
        project={ctx.project}
        options={options}
        members={current}
        candidates={candidates}
        moves={moves}
        canSettings={ctx.capabilities.has("projects.settings.write")}
        canWrite={ctx.capabilities.has("projects.project.write")}
        canMembers={canMembers}
        canArchive={ctx.capabilities.has("projects.project.archive")}
        roles={PROJECT_ROLE_ORDER}
        engagementsHref={
          isNodeVisible(sitemap, "project.engagements", ctx.org.nav)
            ? (nodeHref("project.engagements", routeParams) ?? null)
            : null
        }
      />
      <ProjectAccess ctx={ctx} members={current} roles={PROJECT_ROLE_ORDER} />
      <ProjectInboxSettings ctx={ctx} />
    </>
  );
}
