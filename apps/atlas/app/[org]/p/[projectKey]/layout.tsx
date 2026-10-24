import { getNode, isNodeVisible } from "@xos/ia";
import { listPhases, listScopeNodes } from "@xos/data/projects";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { ProjectTabs, type ProjectTabGroup } from "@/components/projects/project-tabs";
import { ScopePicker } from "@/components/projects/scope-picker";
import { ProjectOpened } from "@/components/shell/recent-projects";
import { PhaseChip, StateChip, Tag } from "@/components/projects/ui";
import { getProjectContextFor } from "@/lib/projects/context";
import { phaseCode, stateIcon } from "@/lib/projects/format";
import { rememberView } from "@/lib/shell/recents";
import { navigableChildren, nodeHref, sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

/**
 * The project frame (Section 4.5.1 and 4.5.4): the project header with key, name, state and phase,
 * the scope picker, and the tab bar grouped by act, showing only the tabs the viewer may open.
 * Every tab page renders inside it. A project the viewer may not read answers 404 (invariant 2).
 * Opening it notes the view, so it leads the recent projects under Projects in the sidebar (Section
 * 4.5.2).
 */
export default async function ProjectLayout({
  children,
  params,
}: LayoutProps<"/[org]/p/[projectKey]">) {
  const routeParams = await params;
  const ctx = await getProjectContextFor(routeParams);
  if (!ctx || !isNodeVisible(sitemap, "project", ctx.org.nav)) notFound();
  const [t, translate, scope, phases] = await Promise.all([
    getTranslations("projects"),
    getTranslate(),
    listScopeNodes(ctx.org.viewer.db, ctx.project.id),
    listPhases(ctx.org.viewer.db),
    rememberView(ctx.org, "projects", ctx.project.id),
  ]);
  if (!scope.ok) throw new Error(`Cannot read the scope tree: ${JSON.stringify(scope.error)}`);
  if (!phases.ok) throw new Error(`Cannot read the phases: ${JSON.stringify(phases.error)}`);
  const gate = phases.data.find((p) => p.code === ctx.project.phaseCode)?.gate ?? 0;
  const { project } = ctx;

  const groups: ProjectTabGroup[] = (getNode(sitemap, "project").node.children ?? []).flatMap(
    (act) => {
      const tabs = navigableChildren(act)
        .filter((tab) => isNodeVisible(sitemap, tab.id, ctx.org.nav))
        .flatMap((tab) => {
          const href = nodeHref(tab.id, routeParams);
          return href ? [{ id: tab.id, label: translate(tab.label), href }] : [];
        });
      return tabs.length > 0 ? [{ id: act.id, label: translate(act.label), tabs }] : [];
    },
  );

  return (
    <div className="flex min-w-0 flex-col gap-16">
      <header className="flex flex-wrap items-end justify-between gap-12">
        <div className="flex min-w-0 flex-col gap-6">
          <p className="m-0 flex min-w-0 items-center gap-8 text-heading-16 font-semibold text-text-primary">
            <span className="rounded-control border border-border-subtle px-6 font-mono text-text-12 text-text-secondary">
              {project.key}
            </span>
            <span className="truncate">{project.name}</span>
          </p>
          <div className="flex flex-wrap items-center gap-6">
            <StateChip
              state={stateIcon(project.projectState)}
              label={t(`states.${project.projectState}`)}
            />
            <PhaseChip
              gate={gate}
              code={phaseCode(project.phaseCode)}
              name={t(`phases.${phaseCode(project.phaseCode)}`)}
            />
            {project.archivedAt ? <Tag tone="warning">{t("header.archived")}</Tag> : null}
          </div>
        </div>
        <Suspense>
          <ScopePicker
            label={t("header.scope")}
            allLabel={t("header.wholeProject")}
            nodes={scope.data.map((n) => ({
              code: n.code,
              label: `${n.name} (${n.code})`,
              depth: n.path.split(".").length - 1,
            }))}
          />
        </Suspense>
      </header>
      <Suspense>
        <ProjectTabs
          label={t("header.tabs")}
          moreLabel={t("header.more")}
          moreName={t("header.moreTabs")}
          groups={groups}
        />
      </Suspense>
      <div className="min-w-0">{children}</div>
      <ProjectOpened href={nodeHref("project", routeParams) ?? ""} />
    </div>
  );
}
