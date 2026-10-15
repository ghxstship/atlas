import { listMembers } from "@xos/data";
import { listAttachments } from "@xos/data/attachments";
import { listThreads } from "@xos/data/comments";
import type { XosClient } from "@xos/data";
import { listCurrencies, toMajor, type MoneyTotal } from "@xos/data/hospitality";
import {
  findOperationsProject,
  getOperationsAccess,
  listOperationsProjects,
  type OperationsAccess,
  type OperationsProject,
} from "@xos/data/logistics";
import { getFormatter, getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { cache, type ReactNode } from "react";
import { requireNode } from "@/components/shell/sitemap-page";
import type { OrgContext } from "@/lib/shell/context";
import { CollabPanels } from "./collab";
import type { CollabSubject } from "./collab-actions";
import { Money } from "./ui";

/**
 * Server helpers shared by the Logistics and Hospitality pages (A11): route guards for module pages
 * and project tabs, the page's query state, formatting in the project time zone, and the comment and
 * attachment panels every record shows.
 */

export type SearchParams = Readonly<Record<string, string | string[] | undefined>>;

/** One query parameter as a string, or undefined. */
export function param(search: SearchParams, name: string): string | undefined {
  const value = search[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The requested view when the page offers it, otherwise the page's default (Section 11.15). */
export function readView<T extends string>(
  search: SearchParams,
  views: readonly T[],
  fallback: T,
): T {
  const asked = param(search, "view");
  return (views as readonly string[]).includes(asked ?? "") ? (asked as T) : fallback;
}

/** The current URL with some query parameters replaced (null removes one). */
export function hrefWith(
  base: string,
  search: SearchParams,
  changes: Readonly<Record<string, string | null>>,
): string {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    const v = Array.isArray(value) ? value[0] : value;
    if (v !== undefined) next.set(key, v);
  }
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) next.delete(key);
    else next.set(key, value);
  }
  const query = next.toString();
  return query ? `${base}?${query}` : base;
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
 * Guard for a project tab: the shell guard resolves the project through A07's project context (a
 * project the viewer cannot read is 404), and the tab reads it again in the shape it needs.
 */
export async function projectTabScope(node: string, params: Readonly<Record<string, string>>) {
  const ctx = await requireNode(node, params);
  const project = await findOperationsProject(
    ctx.viewer.db,
    ctx.org.id,
    params["projectKey"] ?? "",
  );
  if (!project.ok) {
    if (project.error.kind === "not-found") notFound();
    throw new Error(`Cannot read project: ${JSON.stringify(project.error)}`);
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
        : format.dateTime(new Date(`${isoDate}T12:00:00Z`), {
            dateStyle: "medium",
            timeZone: "UTC",
          }),
    /** Minor units in their currency and exponent, or null when unpriced (never shown as zero). */
    money: (amountMinor: number | null, currency: string | null, exponent = 2) =>
      amountMinor === null || currency === null
        ? null
        : format.number(toMajor(amountMinor, exponent), { style: "currency", currency }),
    weekday: (isoDate: string) =>
      format.dateTime(new Date(`${isoDate}T12:00:00Z`), { weekday: "short", timeZone: "UTC" }),
  };
}

/** The calendar date of an instant in a zone, as YYYY-MM-DD. */
export function isoDateIn(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
}

/** The month a calendar shows (`month=YYYY-MM`, default this month) and its neighbors. */
export function calendarMonth(search: SearchParams, now: Date = new Date()) {
  const asked = param(search, "month") ?? "";
  const match = /^(\d{4})-(\d{2})$/.exec(asked);
  const y = match ? Number(match[1]) : now.getUTCFullYear();
  const m = match ? Number(match[2]) : now.getUTCMonth() + 1;
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

/** Minor unit exponents by currency code, read once per request from the currency reference. */
export const getCurrencyExponents = cache(async (db: XosClient): Promise<Map<string, number>> => {
  const currencies = await listCurrencies(db);
  if (!currencies.ok)
    throw new Error(`Cannot read currencies: ${JSON.stringify(currencies.error)}`);
  return new Map(currencies.data.map((c) => [c.code, c.exponent]));
});

/**
 * An amount stored in minor units, shown in its currency with that currency's exponent; Unpriced
 * when NULL (Section 3.7), never zero.
 */
export async function Amount({
  db,
  minor,
  currency,
}: {
  db: XosClient;
  minor: number | null;
  currency: string | null;
}) {
  const t = await getTranslations("logistics.common");
  const exponents = await getCurrencyExponents(db);
  return (
    <Money
      amount={
        minor === null || currency === null ? null : toMajor(minor, exponents.get(currency) ?? 2)
      }
      {...(currency ? { currency } : {})}
      unpricedLabel={t("unpriced")}
    />
  );
}

/** A NULL-aware total: the amount, Unpriced when nothing is priced, and the unpriced count beside it. */
export async function TotalValue({ db, total }: { db: XosClient; total: MoneyTotal }) {
  const t = await getTranslations("logistics.common");
  if (total.mixedCurrencies) return <span>{t("mixedCurrencies")}</span>;
  return (
    <span className="inline-flex flex-wrap items-baseline gap-6">
      <Amount db={db} minor={total.amountMinor} currency={total.currencyCode} />
      {total.unpricedCount > 0 && total.amountMinor !== null ? (
        <span className="text-text-12 text-text-secondary">
          {t("unpricedCount", { count: total.unpricedCount })}
        </span>
      ) : null}
    </span>
  );
}

/** Names of the org's members by person id, for comment authors and guest pickers. */
export async function memberNames(scope: PageScope): Promise<Record<string, string>> {
  const t = await getTranslations("logistics.common");
  const members = await listMembers(scope.ctx.viewer.db, scope.ctx.org.id);
  if (!members.ok) throw new Error(`Cannot read members: ${JSON.stringify(members.error)}`);
  return Object.fromEntries(members.data.map((m) => [m.personId, m.fullName ?? t("unnamed")]));
}

/** Comments and attachments of one record (Section 19.6), loaded for the peek and the full page. */
export async function RecordCollab({
  scope,
  subject,
  canPost,
}: {
  scope: PageScope;
  subject: CollabSubject;
  canPost: boolean;
}) {
  const db = scope.ctx.viewer.db;
  const [threads, attachments, names] = await Promise.all([
    listThreads(db, subject),
    listAttachments(db, subject),
    memberNames(scope),
  ]);
  if (!threads.ok) throw new Error(`Cannot read comments: ${JSON.stringify(threads.error)}`);
  if (!attachments.ok) {
    throw new Error(`Cannot read attachments: ${JSON.stringify(attachments.error)}`);
  }
  return (
    <CollabPanels
      org={scope.ctx.org.slug}
      subject={subject}
      threads={threads.data}
      attachments={attachments.data}
      names={names}
      me={scope.ctx.viewer.person?.id ?? null}
      canPost={canPost}
    />
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
