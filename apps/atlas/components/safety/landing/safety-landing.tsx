import { getNode, isNodeVisible } from "@xos/ia";
import {
  listInspections,
  listInspectionTemplates,
  listPermitRequirements,
} from "@xos/data/safety-permits";
import type { Route } from "next";
import Link from "next/link";
import { Card, PageHeader } from "@/components/places/kit/ui";
import type { OrgContext } from "@/lib/shell/context";
import { navigableChildren, nodeHref, sitemap } from "@/lib/shell/sitemap";
import type { Translate } from "@/lib/shell/translate";

/** The Safety pages A09 owns, whose tiles carry live counts; A14's tiles link by sitemap data only. */
const OWN = new Set(["safety.permits", "safety.inspections", "safety.inspection-templates"]);

interface Counts {
  readonly permits: number;
  readonly untracked: number;
  readonly inspections: number;
  readonly awaitingSignOff: number;
  readonly templates: number;
}

async function counts(ctx: OrgContext, projectId: string | undefined): Promise<Counts> {
  const db = ctx.viewer.db;
  const [permits, inspections, templates] = await Promise.all([
    listPermitRequirements(db, { orgId: ctx.org.id, ...(projectId ? { projectId } : {}) }),
    listInspections(db, { orgId: ctx.org.id, ...(projectId ? { projectId } : {}) }),
    listInspectionTemplates(db, ctx.org.id),
  ]);
  for (const r of [permits, inspections, templates]) {
    if (!r.ok) throw new Error(`Cannot load Safety counts: ${JSON.stringify(r.error)}`);
  }
  const p = permits.ok ? permits.data : [];
  const i = inspections.ok ? inspections.data : [];
  const tplItems = new Map(
    (templates.ok ? templates.data : []).map((tpl) => [tpl.id, tpl.items.length]),
  );
  return {
    permits: p.length,
    untracked: p.filter((r) => r.record === null).length,
    inspections: i.length,
    awaitingSignOff: i.filter(
      (x) =>
        x.signedOffAt === null &&
        x.results.length >= (tplItems.get(x.templateId) ?? Number.POSITIVE_INFINITY),
    ).length,
    templates: templates.ok ? templates.data.length : 0,
  };
}

/**
 * The Safety landing (Section 4.5.5): one tile per Safety page the viewer may open, in sitemap order.
 * Tiles for the permit engine and inspections carry live counts; the incident, dispatch, emergency
 * code and radio pages (A14) are linked from the sitemap alone. With a project, counts and links are
 * narrowed to it, for the project's Safety tab.
 */
export async function SafetyTiles({
  ctx,
  t,
  projectId,
  heading,
}: {
  ctx: OrgContext;
  t: Translate;
  projectId?: string;
  heading?: string;
}) {
  const params = { org: ctx.org.slug };
  const children = navigableChildren(getNode(sitemap, "safety").node).filter((c) =>
    isNodeVisible(sitemap, c.id, ctx.nav),
  );
  const c = await counts(ctx, projectId);
  const meta: Record<string, string> = {
    "safety.permits": t("permits.landing.permitsMeta", {
      count: c.permits,
      untracked: c.untracked,
    }),
    "safety.inspections": t("permits.landing.inspectionsMeta", {
      count: c.inspections,
      waiting: c.awaitingSignOff,
    }),
    "safety.inspection-templates": t("permits.landing.templatesMeta", { count: c.templates }),
  };
  return (
    <nav aria-label={heading ?? t("nav.atlas.items.safety")}>
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(calc(var(--space-40)*6),100%),1fr))] gap-16 p-0">
        {children.map((child) => {
          const href = nodeHref(child.id, params);
          if (!href) return null;
          const target = projectId ? `${href}?project=${projectId}` : href;
          const slug = child.id.split(".")[1] ?? "";
          return (
            <li key={child.id}>
              <Link href={target as Route} className="block h-full no-underline">
                <Card
                  title={t(child.label)}
                  interactive
                  {...(OWN.has(child.id) ? { meta: meta[child.id] } : {})}
                >
                  <p className="m-0 text-text-13 text-text-secondary">
                    {t(`permits.landing.descriptions.${slug}`)}
                  </p>
                </Card>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function SafetyHeader({ t }: { t: Translate }) {
  return <PageHeader title={t("nav.atlas.items.safety")} glyph="ShieldCheck" />;
}
