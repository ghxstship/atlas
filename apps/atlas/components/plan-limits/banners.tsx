import type { OrgBannerStatus } from "@xos/data/org-lifecycle";
import {
  getPlanLimitUsage,
  getProjectOverLimit,
  type ObjectLimit,
  type PlanLimitUsage,
} from "@xos/data/plan-limits";
import type { Route } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import type { ReactElement } from "react";
import { Banner } from "@/components/platform/client/banner";
import type { OrgContext } from "@/lib/shell/context";
import { getTranslate } from "@/lib/shell/translate";

/**
 * A107's banners (Section 16, ADR 0060): what a plan limit made read-only, the limit and how to lift it. The database
 * refuses the writes (plan_limit_read_only); these explain the refusal before anyone meets it. Above every page, billing
 * readers see what is read-only and a person whose own seat is read-only learns it; a read-only project says so on each
 * of its pages; Projects and Members count theirs. The Owner's link goes to the choice in Settings, Billing and Plan;
 * everyone else learns what an Owner can do. Limits come from app.plan_limit_usage, so a seat limit counts extra seats.
 */

type T = (key: string, values?: Record<string, string | number>) => string;

const linkClass = "font-medium text-accent-text underline";

async function copy() {
  const [t, translate] = await Promise.all([getTranslations("planLimits"), getTranslate()]);
  return {
    t: t as unknown as T,
    plan: (code: string) => translate(`shell.plans.${code}.name`),
  };
}

/** The fix: the Owner's link to the choice, or what an Owner can do. */
function Fix({ ctx, t }: { ctx: OrgContext; t: T }) {
  if (ctx.capabilities.has("org.billing.manage")) {
    const href = `/${ctx.org.slug}/settings/billing-and-plan#plan-limits` as Route;
    return (
      <Link href={href} className={linkClass}>
        {t("banners.ownerAction")}
      </Link>
    );
  }
  return <>{t("banners.askOwner")}</>;
}

async function usageOf(ctx: OrgContext): Promise<readonly PlanLimitUsage[]> {
  const usage = await getPlanLimitUsage(ctx.viewer.db, ctx.org.id);
  return usage.ok ? usage.data : [];
}

const limitOf = (usage: readonly PlanLimitUsage[], limit: ObjectLimit) =>
  usage.find((u) => u.limit === limit) ?? null;

/** Org banners above every page, added to A79's lifecycle banners from the same banner status call. */
export async function OverLimitBanners({
  ctx,
  status,
}: {
  ctx: OrgContext;
  status: OrgBannerStatus;
}): Promise<ReactElement[]> {
  const showSummary = status.overLimit !== null && ctx.capabilities.has("org.billing.read");
  if (!showSummary && !status.ownSeatReadOnly) return [];
  const [{ t, plan }, usage, locale] = await Promise.all([copy(), usageOf(ctx), getLocale()]);
  const banners: ReactElement[] = [];
  if (status.ownSeatReadOnly) {
    const own = limitOf(usage, status.ownSeatReadOnly);
    banners.push(
      <Banner key="own-seat" tone="warning" icon="Lock">
        <span data-testid="own-seat-read-only-banner">
          {t(status.ownSeatReadOnly === "seats" ? "banners.ownSeat" : "banners.ownFieldSeat", {
            plan: plan(own?.planCode ?? status.overLimit?.planCode ?? "access"),
            limit: own?.limitValue ?? 0,
          })}{" "}
          <Fix ctx={ctx} t={t} />
        </span>
      </Banner>,
    );
  }
  if (showSummary && status.overLimit) {
    const o = status.overLimit;
    const parts = [
      o.projects > 0 ? t("counts.projects", { count: o.projects }) : null,
      o.seats > 0 ? t("counts.seats", { count: o.seats }) : null,
      o.fieldSeats > 0 ? t("counts.fieldSeats", { count: o.fieldSeats }) : null,
    ].filter((p): p is string => p !== null);
    banners.push(
      <Banner key="over-limit" tone="warning" icon="Lock">
        <span data-testid="over-limit-banner">
          {t("banners.summary", {
            plan: plan(o.planCode),
            items: new Intl.ListFormat(locale, { type: "conjunction" }).format(parts),
            count: o.projects + o.seats + o.fieldSeats,
          })}{" "}
          <Fix ctx={ctx} t={t} />
        </span>
      </Banner>,
    );
  }
  return banners;
}

/** On every page of a read-only project, above its tabs. */
export async function ProjectOverLimitBanner({
  ctx,
  projectId,
}: {
  ctx: OrgContext;
  projectId: string;
}) {
  const over = await getProjectOverLimit(ctx.viewer.db, projectId);
  if (!over.ok || !over.data) return null;
  const [{ t, plan }, usage] = await Promise.all([copy(), usageOf(ctx)]);
  const projects = limitOf(usage, "active_projects");
  return (
    <Banner tone="warning" icon="Lock">
      <span data-testid="project-read-only-banner">
        {t("banners.project", {
          plan: plan(projects?.planCode ?? over.data.planCode),
          limit: projects?.limitValue ?? 0,
        })}{" "}
        <Fix ctx={ctx} t={t} />
      </span>
    </Banner>
  );
}

/** On the pages that list what a limit counts: Projects (active_projects) and Members (seats and field seats). */
export async function LimitBanners({
  ctx,
  limits,
}: {
  ctx: OrgContext;
  limits: readonly ObjectLimit[];
}) {
  const usage = (await usageOf(ctx)).filter((u) => limits.includes(u.limit) && u.readOnly > 0);
  if (usage.length === 0) return null;
  const { t, plan } = await copy();
  const KEY: Record<ObjectLimit, string> = {
    active_projects: "banners.projects",
    seats: "banners.seats",
    field_members: "banners.fieldSeats",
  };
  return (
    <div className="flex flex-col gap-8">
      {usage.map((u) => (
        <Banner key={u.limit} tone="warning" icon="Lock">
          <span data-testid={`limit-banner-${u.limit}`}>
            {t(KEY[u.limit], {
              count: u.readOnly,
              plan: plan(u.planCode),
              limit: u.limitValue ?? 0,
            })}{" "}
            <Fix ctx={ctx} t={t} />
          </span>
        </Banner>
      ))}
    </div>
  );
}
