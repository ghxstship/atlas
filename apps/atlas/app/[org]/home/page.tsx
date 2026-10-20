import { getSubscription, listMembers, listPendingInvites } from "@xos/data";
import { isNodeVisible } from "@xos/ia";
import { CircleCheck, Circle } from "lucide-react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { ButtonLink, PageHeader } from "@/components/ui";
import { requireNode } from "@/lib/shell/require-node";
import { nodeHref, sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";
import { formatAlert } from "@/components/home/format-alert";
import { HomeTiles } from "@/components/home/home-tiles";
import { loadHomeTiles } from "@/lib/home/data";

/**
 * Home (Dashboard template, Section 11.6). A new org sees the first-run checklist of Section 11.7
 * (brand, members, first project, jurisdiction, budget, schedule, Compass invite, integration) and
 * its plan. A step shows Done only when the data proves it. Below them, A07's tiles: project counts,
 * gate readiness, alerts and recent activity (Section 4.2 Home).
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
  const lifecycle = await getTranslations("orgLifecycle");
  const format = await getFormatter();
  const translate = await getTranslate();
  const db = ctx.viewer.db;
  const [members, invites, subscription] = await Promise.all([
    listMembers(db, ctx.org.id),
    ctx.capabilities.has("org.members.read")
      ? listPendingInvites(db, ctx.org.id)
      : Promise.resolve(null),
    getSubscription(db, ctx.org.id),
  ]);
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
  // Alert texts and relative times are formatted here, not during hydration (HomeTiles).
  const alertT = (await getTranslations("home.alerts")) as unknown as Parameters<
    typeof formatAlert
  >[0];
  const now = new Date();
  const tileText = projectTiles
    ? {
        alerts: Object.fromEntries(
          projectTiles.alerts.map((a) => [
            a.id,
            formatAlert(alertT, (date) => format.dateTime(date, { dateStyle: "medium" }), a),
          ]),
        ),
        times: Object.fromEntries(
          projectTiles.activity.map((e) => [e.id, format.relativeTime(new Date(e.at), now)]),
        ),
      }
    : null;
  const billingHref = isNodeVisible(sitemap, "settings.billing-and-plan", ctx.nav)
    ? nodeHref("settings.billing-and-plan", routeParams)
    : undefined;

  return (
    <>
      <PageHeader title={translate("nav.atlas.items.home")} />
      <div className="grid grid-cols-1 gap-16 lg:grid-cols-12">
        <section
          aria-labelledby="home-checklist"
          className="rounded-card border border-border-subtle bg-bg-surface p-16 lg:col-span-8"
        >
          <p className="text-text-13 text-text-secondary">{t("welcome", { org: ctx.org.name })}</p>
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
        <section
          aria-labelledby="home-plan"
          className="flex flex-col gap-12 rounded-card border border-border-subtle bg-bg-surface p-16 lg:col-span-4"
        >
          <h2 id="home-plan" className="text-heading-16 font-semibold">
            {t("plan.title")}
          </h2>
          {subscription.ok && subscription.data.trialEndsAt ? (
            <p className="text-text-13 text-text-secondary">
              {lifecycle("home.trial", {
                org: ctx.org.name,
                date: format.dateTime(new Date(subscription.data.trialEndsAt), {
                  dateStyle: "medium",
                }),
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
      </div>
      {projectTiles && tileText ? (
        <HomeTiles
          org={ctx.org.slug}
          tiles={projectTiles}
          text={tileText}
          links={{
            readiness: nodeHref("home.gate-readiness", routeParams) ?? "",
            alerts: nodeHref("home.alerts", routeParams) ?? "",
            activity: isNodeVisible(sitemap, "activity.feed", ctx.nav)
              ? (nodeHref("activity.feed", routeParams) ?? null)
              : null,
          }}
        />
      ) : null}
    </>
  );
}
