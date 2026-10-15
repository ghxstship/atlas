import { isNodeVisible } from "@xos/ia";
import type { MoneyTotal } from "@xos/data/hospitality";
import {
  findOperationsProject,
  getOperationsAccess,
  listOperationsProjects,
  type OperationsAccess,
  type OperationsProject,
} from "@xos/data/logistics";
import { getFormatter, getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { EmptyStateLink } from "@/components/ui";
import { requireNode } from "@/components/shell/sitemap-page";
import { getOrgContext, type OrgContext } from "@/lib/shell/context";
import { nodeHref, sitemap } from "@/lib/shell/sitemap";
import { Card, Money } from "./ui";

/**
 * Server helpers shared by the Logistics and Hospitality pages (A11): route guards for module pages
 * and project tabs, the page's query state, formatting in the project time zone, and the panels
 * every record shows.
 */

export type SearchParams = Readonly<Record<string, string | string[] | undefined>>;

/** One query parameter as a string, or undefined. */
export function param(search: SearchParams, name: string): string | undefined {
  const value = search[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The requested view when the page offers it, otherwise the page's default (Section 11.15). */
export function readView<T extends string>(search: SearchParams, views: readonly T[], fallback: T): T {
  const asked = param(search, "view");
  return (views as readonly string[]).includes(asked ?? "") ? (asked as T) : fallback;
}

/** What a page renders for: the org, the viewer's access, and the project when it is a tab. */
export interface PageScope {
  readonly ctx: OrgContext;
  readonly params: Readonly<Record<string, string>>;
  readonly access: OperationsAccess;
  readonly projects: readonly OperationsProject[];
  /** The project of a project tab; undefined on the org-level module page. */
  readonly project?: OperationsProject;
}

async function scopeFor(
  ctx: OrgContext,
  params: Readonly<Record<string, string>>,
  project?: OperationsProject,
): Promise<PageScope> {
  const [access, projects] = await Promise.all([
    getOperationsAccess(ctx.viewer.db, ctx.org.id),
    listOperationsProjects(ctx.viewer.db, ctx.org.id),
  ]);
  if (!access.ok) throw new Error(`Cannot read access: ${JSON.stringify(access.error)}`);
  if (!projects.ok) throw new Error(`Cannot read projects: ${JSON.stringify(projects.error)}`);
  return {
    ctx,
    params,
    access: access.data,
    projects: projects.data,
    ...(project ? { project } : {}),
  };
}

/** Guard for an org-level module page: hidden or missing is 404 (ADR 0003). */
export async function moduleScope(node: string, params: Readonly<Record<string, string>>) {
  const ctx = await requireNode(node, params);
  return scopeFor(ctx, params);
}

/**
 * Guard for a project tab. The shell's requireNode answers 404 for every `/p/{projectKey}` route
 * until A07's project resolver lands, so the tab resolves its project here, under row level security:
 * a project the viewer cannot read is 404 like a missing one.
 */
export async function projectTabScope(node: string, params: Readonly<Record<string, string>>) {
  const slug = params["org"];
  const key = params["projectKey"];
  const ctx = slug === undefined ? null : await getOrgContext(slug);
  if (!ctx || key === undefined || !isNodeVisible(sitemap, node, ctx.nav)) notFound();
  const project = await findOperationsProject(ctx.viewer.db, ctx.org.id, key);
  if (!project.ok) {
    if (project.error.kind === "not-found") notFound();
    throw new Error(`Cannot read project ${key}: ${JSON.stringify(project.error)}`);
  }
  return scopeFor(ctx, params, project.data);
}

/** Projects of the scope the viewer may use a capability on: the tab's project, or all of them. */
export function writableProjects(scope: PageScope, capability: string): OperationsProject[] {
  const allowed = scope.access.projectsWith(capability);
  return (scope.project ? [scope.project] : scope.projects).filter((p) => allowed.has(p.id));
}

/** Date and time in a zone, in the viewer's locale. */
export async function getZonedFormat() {
  const format = await getFormatter();
  return {
    dateTime: (instant: string | null, timeZone: string) =>
      instant === null
        ? null
        : format.dateTime(new Date(instant), { dateStyle: "medium", timeStyle: "short", timeZone }),
    time: (instant: string, timeZone: string) =>
      format.dateTime(new Date(instant), { timeStyle: "short", timeZone }),
    date: (isoDate: string | null) =>
      isoDate === null
        ? null
        : format.dateTime(new Date(`${isoDate}T12:00:00Z`), { dateStyle: "medium", timeZone: "UTC" }),
    /** The calendar date of an instant in a zone, as YYYY-MM-DD. */
    isoDate: (instant: string, timeZone: string) =>
      new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
        new Date(instant),
      ),
  };
}

/** The month a calendar shows (`month=YYYY-MM`, default this month) and its neighbors. */
export function calendarMonth(search: SearchParams, now: Date = new Date()) {
  const asked = param(search, "month");
  const [y, m] = /^\d{4}-\d{2}$/.test(asked ?? "")
    ? (asked as string).split("-").map(Number) as [number, number]
    : [now.getUTCFullYear(), now.getUTCMonth() + 1];
  const iso = (year: number, month: number) => {
    const d = new Date(Date.UTC(year, month - 1, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  };
  return {
    month: `${iso(y, m)}-01`,
    previous: iso(y, m - 1),
    next: iso(y, m + 1),
    today: now.toISOString().slice(0, 10),
  };
}

/** A NULL-aware total: the amount, Unpriced when nothing is priced, and the unpriced count beside it. */
export async function TotalValue({ total }: { total: MoneyTotal }) {
  const t = await getTranslations("logistics.common");
  if (total.mixedCurrencies) return <span>{t("mixedCurrencies")}</span>;
  return (
    <span className="inline-flex flex-wrap items-baseline gap-6">
      <Money
        amount={total.amountMinor}
        {...(total.currencyCode ? { currency: total.currencyCode } : {})}
        unpricedLabel={t("unpriced")}
      />
      {total.unpricedCount > 0 && total.amountMinor !== null ? (
        <span className="text-text-12 text-text-secondary">
          {t("unpricedCount", { count: total.unpricedCount })}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Comments and attachments, in the blocked state that names the feature (broadcast 1, section 3):
 * A18 builds the shared comment and attachment system; until it ships each panel says so and links
 * to where the work happens meanwhile.
 */
export async function BlockedPanels({ scope }: { scope: PageScope }) {
  const t = await getTranslations("logistics.common");
  const activity = nodeHref("activity.feed", scope.params) ?? nodeHref("home", scope.params);
  const documents = nodeHref("knowledge.documents", scope.params) ?? nodeHref("home", scope.params);
  return (
    <div className="grid gap-12 md:grid-cols-2">
      <Card title={t("comments.title")}>
        <EmptyStateLink
          icon="MessageSquare"
          sentence={t("comments.blocked")}
          actionLabel={t("comments.action")}
          href={activity ?? "/"}
        />
      </Card>
      <Card title={t("attachments.title")}>
        <EmptyStateLink
          icon="Paperclip"
          sentence={t("attachments.blocked")}
          actionLabel={t("attachments.action")}
          href={documents ?? "/"}
        />
      </Card>
    </div>
  );
}

/** A titled section of a record page. */
export function Section({
  id,
  title,
  actions,
  children,
}: {
  id: string;
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-8">
        <h2 id={id} className="m-0 text-heading-16 font-semibold">
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}
