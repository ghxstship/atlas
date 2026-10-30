import { getSubscription, listMembers, listPendingInvites } from "@xos/data";
import { resolveSettings } from "@xos/data/settings";
import { windowLastDay } from "@xos/data/org-lifecycle";
import { isNodeVisible } from "@xos/ia";
import { CircleCheck, Circle } from "lucide-react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { ButtonLink, PageHeader } from "@/components/ui";
import { requireNode } from "@/lib/shell/require-node";
import { nodeHref, sitemap } from "@/lib/shell/sitemap";
import { getOrgTimeZone } from "@/lib/shell/time-zone";
import { getTranslate } from "@/lib/shell/translate";
import type { DashboardTile } from "@xos/ui";
import { DashboardGrid } from "@/components/dashboard/dashboard-grid";
import { formatAlert } from "@/components/home/format-alert";
import { ActivityTile, AlertsTile, ReadinessTile } from "@/components/home/home-tiles";
import { StatTile } from "@/components/platform/client/stat-tile";
import { RegionFailed } from "@/components/shell/region";
import { savedLayout } from "@/lib/dashboard/layout";
import { loadHomeTiles } from "@/lib/home/data";

/**
 * Home (Dashboard template, Section 11.6). A new org sees the first-run checklist of Section 11.7
 * (brand, members, first project, jurisdiction, budget, schedule, Compass invite, integration) and
 * its plan. A step shows Done only when the data proves it. Below them, A07's tiles: project counts,
 * gate readiness, alerts and recent activity (Section 4.2 Home). Every block is a tile on the
 * 12-column grid, at the spans the person saved in me.dashboard_layout.home (A129). Each tile reads
 * on its own: one whose read failed shows Retry and the others render (ADR 0118).
 */
const STEPS = [
  { key: "brand", node: "settings.white-label" },
  { key: "members", node: "settings.members" },
  { key: "project", node: "projects.all" },
  { key: "jurisdiction", node: "canon.jurisdictions-and-permit-rules" },
  { key: "budget", node: "finance.budgets" },
  { key: "schedule", node: "schedule.milestones" },
  { key: "compass", node: "settings.members" },
  { key: "integration", node: "settings.integrations" },
] as const;

export default async function HomePage({ params }: PageProps<"/[org]/home">) {
  const routeParams = await params;
  const ctx = await requireNode("home", routeParams);
  const t = await getTranslations("shell.home");
  const dashboard = await getTranslations("home");
  const translate = await getTranslate();
  const lifecycle = await getTranslations("orgLifecycle");
  const db = ctx.viewer.db;
  const zone = await getOrgTimeZone(ctx);
  // The setup checklist and the plan card ask for actions only an Owner or Admin can take, so only
  // they see them (Section 11.7, A59-014); everyone else starts on the tiles.
  const setsUp = ctx.role === "owner" || ctx.role === "admin";
  const partnerConsole = setsUp && [...(ctx.nav.conditions ?? [])].includes("partner-org");
  const [members, invites, subscription, settings] = await Promise.all([
    listMembers(db, ctx.org.id),
    ctx.capabilities.has("org.members.read")
      ? listPendingInvites(db, ctx.org.id)
      : Promise.resolve(null),
    getSubscription(db, ctx.org.id),
    resolveSettings(db, { orgId: ctx.org.id }),
  ]);
  // A layout that cannot be read leaves every tile at its default span.
  const saved = savedLayout("home", (key) => (settings.ok ? settings.data.get(key)?.value : null));
  const teamInvited =
    (members.ok && members.data.length > 1) || (invites?.ok === true && invites.data.length > 0);
  const projectTiles = isNodeVisible(sitemap, "projects", ctx.nav)
    ? await loadHomeTiles(ctx)
    : null;
  const done: Record<string, boolean> = {
    members: teamInvited,
    project: (projectTiles?.projectCount ?? 0) > 0,
  };
  const steps = STEPS.filter((s) => isNodeVisible(sitemap, s.node, ctx.nav)).flatMap((s) => {
    const href = nodeHref(s.node, routeParams);
    return href === undefined ? [] : [{ ...s, href, done: done[s.key] === true }];
  });
  const completed = steps.filter((s) => s.done).length;
  // Alert texts and relative times are formatted here, not during hydration (home-tiles.tsx).
  const format = await getFormatter();
  const alertT = (await getTranslations("home.alerts")) as unknown as Parameters<
    typeof formatAlert
  >[0];
  const now = new Date();
  // An overdue record's due date reads on the org's calendar (`zone`, above), like the alerts' "today" (A71).
  const tileText = projectTiles
    ? {
        alerts: Object.fromEntries(
          (projectTiles.alerts.ok ? projectTiles.alerts.data : []).map((a) => [
            a.id,
            formatAlert(
              alertT,
              (date, timeZone) => format.dateTime(date, { dateStyle: "medium", timeZone }),
              a,
              zone,
            ),
          ]),
        ),
        times: Object.fromEntries(
          (projectTiles.activity.ok ? projectTiles.activity.data : []).map((e) => [
            e.id,
            format.relativeTime(new Date(e.at), now),
          ]),
        ),
      }
    : null;
  const billingHref = isNodeVisible(sitemap, "settings.billing-and-plan", ctx.nav)
    ? nodeHref("settings.billing-and-plan", routeParams)
    : undefined;

  const tiles: DashboardTile[] = [];
  if (partnerConsole) {
    // A partner agency's Owners and Admins start from the Partner console (A59-020).
    tiles.push({
      id: "partner-console",
      label: translate("shell.settings.partnerConsole.title"),
      span: 12,
      minSpan: 6,
      content: (
        <section
          aria-labelledby="home-partner"
          className="flex flex-col gap-8 rounded-card border border-border-subtle bg-bg-surface p-16"
        >
          <h2 id="home-partner" className="m-0 text-heading-16 font-semibold">
            {translate("shell.settings.partnerConsole.title")}
          </h2>
          <p className="m-0 text-text-13 text-text-secondary">
            {translate("shell.settings.partnerConsole.lead", { org: ctx.org.name })}
          </p>
          <div>
            <ButtonLink href={`/partner/${ctx.org.slug}`} variant="primary">
              {translate("shell.settings.partnerConsole.open")}
            </ButtonLink>
          </div>
        </section>
      ),
    });
  }
  if (setsUp) {
    tiles.push(
      {
        id: "checklist",
        label: t("checklist.title", { org: ctx.org.name }),
        span: 8,
        minSpan: 4,
        content: (
          <section
            aria-labelledby="home-checklist"
            className="rounded-card border border-border-subtle bg-bg-surface p-16"
          >
            <p className="text-text-13 text-text-secondary">
              {t("welcome", { org: ctx.org.name })}
            </p>
            <h2 id="home-checklist" className="mt-4 text-heading-16 font-semibold">
              {t("checklist.title", { org: ctx.org.name })}
            </h2>
            <p className="mt-4 text-text-13 text-text-secondary">
              {t("checklist.progress", { done: completed, total: steps.length })}
            </p>
            <ol className="mt-16 flex flex-col divide-y divide-border-subtle">
              {steps.map((step) => (
                <li key={step.key}>
                  <Link
                    href={step.href}
                    className="flex items-start gap-12 py-12 hover:bg-bg-hover focus-visible:bg-bg-hover"
                  >
                    {step.done ? (
                      <CircleCheck
                        aria-hidden="true"
                        className="mt-2 size-16 shrink-0 text-success-text"
                      />
                    ) : (
                      <Circle
                        aria-hidden="true"
                        className="mt-2 size-16 shrink-0 text-text-tertiary"
                      />
                    )}
                    <span className="flex flex-col gap-2">
                      <span className="text-label-13 font-medium text-text-primary">
                        {t(`checklist.steps.${step.key}.title`)}
                      </span>
                      <span className="sr-only">
                        {step.done ? t("checklist.done") : t("checklist.todo")}
                      </span>
                      <span className="text-text-13 text-text-secondary">
                        {t(`checklist.steps.${step.key}.body`)}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ol>
          </section>
        ),
      },
      {
        id: "plan",
        label: t("plan.title"),
        span: 4,
        content: (
          <section
            aria-labelledby="home-plan"
            className="flex flex-col gap-12 rounded-card border border-border-subtle bg-bg-surface p-16"
          >
            <h2 id="home-plan" className="text-heading-16 font-semibold">
              {t("plan.title")}
            </h2>
            {subscription.ok && subscription.data.trialEndsAt ? (
              <p className="text-text-13 text-text-secondary">
                {lifecycle("home.trial", {
                  org: ctx.org.name,
                  // The trial's last day on the org's calendar, formatted as that calendar day.
                  date: format.dateTime(
                    new Date(`${windowLastDay(subscription.data.trialEndsAt, zone)}T00:00:00Z`),
                    { dateStyle: "medium", timeZone: "UTC" },
                  ),
                })}
              </p>
            ) : subscription.ok ? (
              <p className="text-text-13 text-text-secondary">
                {t("plan.current", {
                  org: ctx.org.name,
                  plan: translate(`shell.plans.${subscription.data.planCode}.name`),
                })}
              </p>
            ) : null}
            {billingHref ? (
              <div>
                <ButtonLink href={billingHref}>{t("plan.action")}</ButtonLink>
              </div>
            ) : null}
          </section>
        ),
      },
    );
  }
  if (projectTiles && tileText) {
    tiles.push(
      {
        id: "active",
        label: dashboard("dashboard.activeProjects"),
        span: 3,
        content: projectTiles.active.ok ? (
          <StatTile
            label={dashboard("dashboard.activeProjects")}
            value={projectTiles.active.data}
            caption={dashboard("dashboard.activeCaption")}
          />
        ) : (
          <RegionFailed />
        ),
      },
      {
        id: "blocked",
        label: dashboard("dashboard.blockedProjects"),
        span: 3,
        content: projectTiles.blocked.ok ? (
          <StatTile
            label={dashboard("dashboard.blockedProjects")}
            value={projectTiles.blocked.data}
            caption={dashboard("dashboard.blockedCaption")}
          />
        ) : (
          <RegionFailed />
        ),
      },
      {
        id: "due-today",
        label: dashboard("dashboard.dueToday"),
        span: 3,
        content: projectTiles.dueToday.ok ? (
          <StatTile
            label={dashboard("dashboard.dueToday")}
            value={projectTiles.dueToday.data}
            caption={dashboard("dashboard.dueCaption")}
          />
        ) : (
          <RegionFailed />
        ),
      },
      {
        id: "open-blockers",
        label: dashboard("dashboard.openBlockers"),
        span: 3,
        content: projectTiles.openBlockers.ok ? (
          <StatTile
            label={dashboard("dashboard.openBlockers")}
            value={projectTiles.openBlockers.data}
            caption={dashboard("dashboard.openCaption")}
          />
        ) : (
          <RegionFailed />
        ),
      },
      {
        id: "readiness",
        label: dashboard("dashboard.readinessTitle"),
        span: 4,
        content: (
          <ReadinessTile
            org={ctx.org.slug}
            readiness={projectTiles.readiness}
            href={nodeHref("home.gate-readiness", routeParams) ?? ""}
          />
        ),
      },
      {
        id: "alerts",
        label: dashboard("dashboard.alertsTitle"),
        span: 4,
        content: (
          <AlertsTile
            alerts={projectTiles.alerts}
            text={tileText.alerts}
            href={nodeHref("home.alerts", routeParams) ?? ""}
          />
        ),
      },
      {
        id: "activity",
        label: dashboard("dashboard.recentTitle"),
        span: 4,
        content: (
          <ActivityTile
            activity={projectTiles.activity}
            times={tileText.times}
            href={
              isNodeVisible(sitemap, "activity.feed", ctx.nav)
                ? (nodeHref("activity.feed", routeParams) ?? null)
                : null
            }
          />
        ),
      },
    );
  }

  return (
    <DashboardGrid
      dashboard="home"
      header={<PageHeader title={translate("nav.atlas.items.home")} />}
      tiles={tiles}
      saved={saved}
      label={dashboard("tiles")}
    />
  );
}
