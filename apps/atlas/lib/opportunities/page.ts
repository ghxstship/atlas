import type { Result } from "@xos/data";
import { listApplications, listEngagements } from "@xos/data/opportunities";
import { getNode, isNodeVisible } from "@xos/ia";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { requireNode } from "@/lib/shell/require-node";
import type { OrgContext } from "@/lib/shell/context";
import { nodeHref, sitemap } from "@/lib/shell/sitemap";
import { enumKey } from "./format";

/**
 * Shared setup for every Opportunities page: the route guard (404, never 403), the catalog, the locale, the views the
 * sitemap declares for the node with the one in force, and a query-string builder that keeps the view while it changes
 * the panel (Section 11.15: switching views keeps the person's place).
 */

export type Translate = (key: string, values?: Record<string, string | number | Date>) => string;
export type SearchParams = Readonly<Record<string, string | string[] | undefined>>;

export interface PageSetup {
  readonly ctx: OrgContext;
  readonly t: Translate;
  readonly locale: string;
  readonly base: string;
  readonly view: string;
  readonly views: readonly { readonly id: string; readonly label: string }[];
  readonly param: (name: string) => string | undefined;
  readonly href: (changes: Readonly<Record<string, string | null>>) => string;
}

export async function setupPage(
  node: string,
  params: Readonly<Record<string, string>>,
  searchParams: SearchParams,
  projectOrg?: OrgContext,
): Promise<PageSetup> {
  // Project tabs name a data row ({projectKey}); their page resolves the project first and passes its org context.
  const ctx = projectOrg ?? (await requireNode(node, params));
  if (projectOrg && !isNodeVisible(sitemap, node, projectOrg.nav)) notFound();
  const [translations, locale] = await Promise.all([getTranslations("opportunities"), getLocale()]);
  const t = translations as unknown as Translate;
  const entry = getNode(sitemap, node).node;
  const declared = entry.list?.views ?? [];
  const param = (name: string) => {
    const v = searchParams[name];
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  const requested = param("view");
  const view =
    requested && (declared as readonly string[]).includes(requested)
      ? requested
      : (entry.list?.default ?? declared[0] ?? "list");
  const base = nodeHref(node, params) ?? "/";
  const href = (changes: Readonly<Record<string, string | null>>) => {
    const query = new URLSearchParams();
    if (view !== entry.list?.default) query.set("view", view);
    for (const [k, v] of Object.entries(searchParams))
      if (typeof v === "string" && k !== "view") query.set(k, v);
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) query.delete(k);
      else query.set(k, v);
    }
    const qs = query.toString();
    return qs ? `${base}?${qs}` : base;
  };
  return {
    ctx,
    t,
    locale,
    base,
    view,
    views: declared.map((id) => ({ id, label: t(`views.${enumKey(id)}`) })),
    param,
    href,
  };
}

/** Throws for a repository failure the page cannot explain; the segment error boundary shows the retry. */
export function must<T>(result: Result<T>, what: string): T {
  if (!result.ok) throw new Error(`Cannot read ${what}: ${JSON.stringify(result.error)}`);
  return result.data;
}

export interface PartyOption {
  readonly value: string;
  readonly label: string;
  readonly kind: "person" | "org";
}

/**
 * External people and accounts the org already knows, from its engagements and applications, as `person:<id>` and
 * `org:<id>` options for invitations and pools. Names come from the owner-run boards (migration 0775).
 */
export async function knownParties(ctx: OrgContext): Promise<PartyOption[]> {
  const [engagements, applications] = await Promise.all([
    listEngagements(ctx.viewer.db, ctx.org.id),
    listApplications(ctx.viewer.db, ctx.org.id),
  ]);
  const options = new Map<string, PartyOption>();
  for (const e of must(engagements, "engagements")) {
    if (e.personId && e.partyName)
      options.set(`person:${e.personId}`, {
        value: `person:${e.personId}`,
        label: e.partyName,
        kind: "person",
      });
    if (e.accountId && e.accountName)
      options.set(`org:${e.accountId}`, {
        value: `org:${e.accountId}`,
        label: e.accountName,
        kind: "org",
      });
  }
  for (const a of must(applications, "applications")) {
    if (a.applicantPersonId && a.applicantName)
      options.set(`person:${a.applicantPersonId}`, {
        value: `person:${a.applicantPersonId}`,
        label: a.applicantName,
        kind: "person",
      });
    if (a.applicantOrganizationId && a.applicantName)
      options.set(`org:${a.applicantOrganizationId}`, {
        value: `org:${a.applicantOrganizationId}`,
        label: a.applicantName,
        kind: "org",
      });
  }
  return [...options.values()].sort((x, y) => x.label.localeCompare(y.label));
}
