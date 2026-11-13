import { listMembers, listRoles, type Member } from "@xos/data";
import { departmentsInUse, getDepartmentsInUse } from "@xos/data/org-setup";
import { listDepartments, listProjects, type ProjectSummary } from "@xos/data/projects";
import { listGroups, type Group } from "@xos/data/workforce-chat";
import type { Audience } from "@xos/data/workforce-shared";
import type { FieldSpec } from "@/components/collection-kit/kit";
import { PageHeader } from "@/components/collection-kit/ui";
import { CollectionPage } from "@/components/platform/collection-page";
import { EmptyStateLink } from "@/components/ui";
import { getCopy, type Copy } from "@/lib/collection-kit/i18n";
import type { OrgContext } from "@/lib/shell/context";
import { nodeHref } from "@/lib/shell/sitemap";

/**
 * Shared server helpers of the workforce pages (A29): the copy, the org's projects, teams, roles,
 * groups and members for pickers, the audience picker fields and the project picker of the site
 * operations pages.
 */

export { REFUSALS } from "./refusals";

export function workforceCopy(): Promise<Copy> {
  return getCopy("workforce");
}

export interface OrgPickers {
  readonly projects: readonly ProjectSummary[];
  readonly roles: readonly { id: string; name: string }[];
  readonly groups: readonly Group[];
  readonly teams: readonly { id: string; name: string }[];
  readonly members: readonly Member[];
  /**
   * Canon departments (code and name), the targets of a Department audience on feed posts: the departments the
   * org works in once it chose them (Settings, Departments and Disciplines in Use, 1430), else every one.
   */
  readonly departments: readonly { code: string; label: string }[];
}

/** Projects, roles, groups, teams, members and canon departments; an unreadable list is empty. */
export async function orgPickers(ctx: OrgContext): Promise<OrgPickers> {
  const db = ctx.viewer.db;
  const [projects, roles, groups, teams, members, departments, inUse] = await Promise.all([
    listProjects(db, ctx.org.id),
    listRoles(db, ctx.org.id),
    listGroups(db, ctx.org.id),
    db
      .from("teams")
      .select("id, name")
      .eq("org_id", ctx.org.id)
      .is("deleted_at", null)
      .order("name"),
    listMembers(db, ctx.org.id),
    listDepartments(db),
    getDepartmentsInUse(db, ctx.org.id),
  ]);
  return {
    projects: projects.ok ? projects.data : [],
    roles: roles.ok ? roles.data.map((r) => ({ id: r.id, name: r.name ?? r.code })) : [],
    groups: groups.ok ? groups.data.filter((g) => g.archivedAt === null) : [],
    teams: (teams.data ?? []).map((t) => ({ id: t.id, name: t.name })),
    members: members.ok ? members.data : [],
    departments: departments.ok
      ? departmentsInUse(departments.data, inUse.ok ? inUse.data.departments : [])
      : [],
  };
}

/**
 * The audience picker: a kind and one target of that kind, listed together. Feed posts also reach a
 * canon department (`withDepartments`, 1365), named as "Production · 5000" (plain words before codes).
 */
export function audienceFields(
  t: Copy,
  pickers: OrgPickers,
  options: { readonly withDepartments?: boolean } = {},
): FieldSpec[] {
  const departments = options.withDepartments ? pickers.departments : [];
  const target = [
    ...pickers.projects.map((p) => ({
      value: p.id,
      label: t("audience.projectOption", { name: `${p.key} ${p.name}` }),
    })),
    ...pickers.teams.map((x) => ({
      value: x.id,
      label: t("audience.teamOption", { name: x.name }),
    })),
    ...departments.map((d) => ({
      value: d.code,
      label: t("audience.departmentOption", { name: d.label, code: d.code }),
    })),
    ...pickers.roles.map((x) => ({
      value: x.id,
      label: t("audience.roleOption", { name: x.name }),
    })),
    ...pickers.groups.map((x) => ({
      value: x.id,
      label: t("audience.groupOption", { name: x.name }),
    })),
  ];
  return [
    {
      kind: "select",
      name: "audienceKind",
      label: t("audience.kind"),
      defaultValue: "Organization",
      options: [
        "Organization",
        "Project",
        "Team",
        ...(options.withDepartments ? ["Department"] : []),
        "Role",
        "Group",
      ].map((k) => ({
        value: k,
        label: t(`audience.kinds.${k}`),
      })),
    },
    {
      kind: "select",
      name: "audienceTarget",
      label: t("audience.target"),
      help: t("audience.targetHelp"),
      blankLabel: t("audience.wholeOrg"),
      options: target,
    },
  ];
}

/** Who a row reaches, in words. */
export function audienceLabel(t: Copy, a: Audience, pickers: OrgPickers): string {
  switch (a.kind) {
    case "Organization":
      return t("audience.everyone");
    case "Project": {
      const p = pickers.projects.find((x) => x.id === a.projectId);
      return p ? `${p.key} ${p.name}` : t("audience.kinds.Project");
    }
    case "Team":
      return pickers.teams.find((x) => x.id === a.teamId)?.name ?? t("audience.kinds.Team");
    case "Department": {
      const d = pickers.departments.find((x) => x.code === a.departmentCode);
      return d
        ? t("audience.departmentOption", { name: d.label, code: d.code })
        : t("audience.kinds.Department");
    }
    case "Role":
      return pickers.roles.find((x) => x.id === a.roleId)?.name ?? t("audience.kinds.Role");
    case "Group":
      return pickers.groups.find((x) => x.id === a.groupId)?.name ?? t("audience.kinds.Group");
  }
}

export function memberOptions(members: readonly Member[], exclude?: string) {
  return members
    .filter((m) => m.membershipId !== exclude)
    .map((m) => ({ value: m.membershipId, label: m.fullName ?? m.membershipId }));
}

export function memberName(
  members: readonly Member[],
  membershipId: string | null,
  fallback: string,
): string {
  return members.find((m) => m.membershipId === membershipId)?.fullName ?? fallback;
}

/**
 * The project a site operations page shows: the `project` query by id or key, else the org's only project. Of several
 * projects none is picked silently (crawl 4.9): the list holds every project the person can read, and the first could be
 * one they only see through a shift, where the page offers nothing. Null asks the person to choose.
 */
export function chosenProject(
  projects: readonly ProjectSummary[],
  search: Readonly<Record<string, string | string[] | undefined>>,
): ProjectSummary | null {
  const raw = search["project"];
  const wanted = Array.isArray(raw) ? raw[0] : raw;
  if (wanted) return projects.find((p) => p.id === wanted || p.key === wanted) ?? null;
  return projects.length === 1 ? (projects[0] ?? null) : null;
}

/**
 * A site operations page with no project in scope: with no projects, the way to create one; otherwise the project
 * picker, starting on "Choose a project".
 */
export function NoSiteProject({
  ctx,
  t,
  title,
  path,
  projects,
}: {
  ctx: OrgContext;
  t: Copy;
  title: string;
  path: string;
  projects: readonly ProjectSummary[];
}) {
  if (projects.length === 0) {
    return (
      <CollectionPage header={<PageHeader title={title} />}>
        <EmptyStateLink
          icon="FolderPlus"
          sentence={t("site.noProjects")}
          actionLabel={t("site.openProjects")}
          href={nodeHref("projects.all", { org: ctx.org.slug }) ?? "/"}
        />
      </CollectionPage>
    );
  }
  return (
    <CollectionPage header={<PageHeader title={title} />}>
      <ProjectPicker t={t} path={path} projects={projects} current={null} />
      <p className="m-0 text-text-14 text-text-secondary">{t("site.choosePrompt")}</p>
    </CollectionPage>
  );
}

/** A small GET form that switches the project of a site operations page. */
export function ProjectPicker({
  t,
  path,
  projects,
  current,
}: {
  t: Copy;
  path: string;
  projects: readonly ProjectSummary[];
  current: ProjectSummary | null;
}) {
  return (
    <form method="get" action={path} className="flex flex-wrap items-end gap-8">
      <div className="flex flex-col gap-4">
        <label htmlFor="site-project" className="text-label-13 font-medium">
          {t("site.project")}
        </label>
        <select
          id="site-project"
          name="project"
          defaultValue={current?.id ?? ""}
          className="h-control-md max-w-full rounded-control border border-border-control bg-bg-surface px-8 text-text-13"
        >
          {current === null ? <option value="">{t("site.chooseProject")}</option> : null}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.key} {p.name}
            </option>
          ))}
        </select>
      </div>
      <button
        type="submit"
        className="h-control-md rounded-control border border-border-control bg-bg-surface px-12 text-text-13 font-medium"
      >
        {t("site.show")}
      </button>
    </form>
  );
}
