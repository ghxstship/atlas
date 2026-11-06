import { listCrewProjects, listShiftPlanningProjectIds } from "@xos/data/crew";
import { listCrewAccessLinks, type CrewAccessLink } from "@xos/data/crew-access";
import { CrewAccessIssue } from "@/components/crew/crew-access-issue";
import { Muted, Table, ViewSwitch } from "@/components/opportunities/parts";
import { Card, PageHeader, Tag, TemplateCollection } from "@/components/opportunities/ui";
import { FilterSelect } from "@/components/crew/views-filter-select";
import { Button } from "@xos/ui";
import { ButtonLink, EmptyStateLink } from "@/components/ui";
import { flatParams, getCrewContext, withParams } from "@/lib/crew/context";
import { nodeHref, sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";
import { getNode } from "@xos/ia";
import { getFormatter } from "next-intl/server";
import { revokeCrewAccessLinkAction } from "./actions";

const TONES: Readonly<
  Record<CrewAccessLink["status"], "success" | "warning" | "neutral" | "danger">
> = {
  Live: "success",
  Locked: "danger",
  Expired: "neutral",
  Revoked: "neutral",
  Closed: "warning",
};

/**
 * Crew access links (B10, G-125, ADR 0149 decision 2): a link and a 6-digit code that show one worker their own shifts on
 * one project in Gateway without signing in, and let them accept their own Published shift. Only projects the caller may
 * staff (crew.shift.write there) appear, in the list, the filter and the issue form. The issue form is its own state
 * (?issue=1), and the page does not refresh while the one view of the codes is open.
 */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/crew/access-links">) {
  const routeParams = await params;
  const search = flatParams(await searchParams);
  const node = "crew.access-links";
  const crew = await getCrewContext(node, routeParams);
  const t = await getTranslate();
  const format = await getFormatter();
  const db = crew.ctx.viewer.db;
  const base = nodeHref(node, routeParams) ?? "/";
  const entry = getNode(sitemap, node).node;
  const views = entry.list?.views ?? ["list"];
  const view = views.includes(search["view"] as never)
    ? (search["view"] as string)
    : (entry.list?.default ?? "list");
  const [allProjects, staffable] = await Promise.all([
    listCrewProjects(db, crew.orgId),
    listShiftPlanningProjectIds(db, crew.orgId),
  ]);
  if (!allProjects.ok) throw new Error(`Cannot list projects: ${allProjects.error.kind}`);
  if (!staffable.ok) throw new Error(`Cannot read the projects to staff: ${staffable.error.kind}`);
  const projects = allProjects.data.filter((p) => staffable.data.has(p.id));
  const projectFilter = projects.find((p) => p.id === search["project"]) ?? null;
  const links = await listCrewAccessLinks(db, {
    orgId: crew.orgId,
    projectId: projectFilter?.id ?? null,
  });
  if (!links.ok) throw new Error(`Cannot list crew access links: ${links.error.kind}`);
  const canIssue = projects.length > 0;
  const issuing = search["issue"] === "1" && canIssue;
  const issueHref = withParams(base, search, { issue: "1" });
  const closeHref = withParams(base, search, { issue: null });
  const when = (iso: string | null) =>
    iso
      ? format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" })
      : t("crew.crewAccess.never");
  const status = (l: CrewAccessLink) => (
    <Tag tone={TONES[l.status]}>{t(`crew.crewAccess.statuses.${l.status}`)}</Tag>
  );
  const revoke = (l: CrewAccessLink) =>
    l.status === "Revoked" ? null : (
      <form action={revokeCrewAccessLinkAction}>
        <input type="hidden" name="org" value={crew.slug} />
        <input type="hidden" name="id" value={l.id} />
        <Button type="submit" variant="secondary">
          {t("crew.crewAccess.revoke")}
        </Button>
      </form>
    );
  return (
    <TemplateCollection
      header={
        <PageHeader
          title={t("crew.crewAccess.title")}
          count={links.data.length}
          views={
            <ViewSwitch
              label={t("crew.crewAccess.viewsLabel")}
              views={views.map((id) => ({ id, label: t(`crew.crewAccess.views.${id}`) }))}
              current={view}
              hrefFor={(v) => withParams(base, search, { view: v })}
            />
          }
          actions={
            canIssue && !issuing ? (
              <ButtonLink href={issueHref} variant="primary">
                {t("crew.crewAccess.issueLinks")}
              </ButtonLink>
            ) : null
          }
        />
      }
    >
      {issuing ? (
        <Card title={t("crew.crewAccess.issue.title")}>
          <CrewAccessIssue
            org={crew.slug}
            projects={projects.map((p) => ({ id: p.id, name: p.name }))}
            initialProject={projectFilter?.id ?? null}
            closeHref={closeHref}
          />
        </Card>
      ) : null}
      {projects.length > 1 ? (
        <FilterSelect
          label={t("crew.crewAccess.filterProject")}
          name="project"
          value={projectFilter?.id ?? ""}
          options={[
            { value: "", label: t("crew.crewAccess.allProjects") },
            ...projects.map((p) => ({ value: p.id, label: p.name })),
          ]}
        />
      ) : null}
      {links.data.length === 0 && !issuing ? (
        canIssue ? (
          <EmptyStateLink
            icon="Link"
            sentence={t("crew.crewAccess.empty")}
            actionLabel={t("crew.crewAccess.issueLinks")}
            href={issueHref}
            secondary
          />
        ) : (
          <Muted>{t("crew.crewAccess.noProjects")}</Muted>
        )
      ) : view === "table" ? (
        <Table
          caption={t("crew.crewAccess.title")}
          rowKey={(l) => l.id}
          rows={links.data}
          columns={[
            {
              key: "person",
              label: t("crew.fields.person"),
              cell: (l: CrewAccessLink) => l.personName ?? t("crew.common.unnamed"),
            },
            {
              key: "project",
              label: t("crew.fields.project"),
              cell: (l: CrewAccessLink) => l.projectName ?? "",
            },
            { key: "status", label: t("crew.crewAccess.status"), cell: status },
            {
              key: "expires",
              label: t("crew.crewAccess.expires"),
              cell: (l: CrewAccessLink) => when(l.expiresAt),
            },
            {
              key: "opened",
              label: t("crew.crewAccess.lastOpened"),
              cell: (l: CrewAccessLink) => when(l.lastOpenedAt),
            },
            {
              key: "opens",
              label: t("crew.crewAccess.openCount"),
              numeric: true,
              cell: (l: CrewAccessLink) => l.openCount,
            },
            { key: "revoke", label: t("crew.crewAccess.actions"), cell: revoke },
          ]}
        />
      ) : (
        <ul
          aria-label={t("crew.crewAccess.title")}
          className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0"
        >
          {links.data.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center justify-between gap-8 px-12 py-8">
              <span className="flex flex-col">
                <span className="text-text-13 font-medium">
                  {l.personName ?? t("crew.common.unnamed")}
                </span>
                <span className="text-text-12 text-text-secondary">
                  {t("crew.crewAccess.listLine", {
                    project: l.projectName ?? "",
                    expires: when(l.expiresAt),
                    opened: when(l.lastOpenedAt),
                    count: l.openCount,
                  })}
                </span>
              </span>
              <span className="flex items-center gap-8">
                {status(l)}
                {revoke(l)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </TemplateCollection>
  );
}
