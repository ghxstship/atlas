import { getSeatUsage, getSubscription, listMembers } from "@xos/data";
import { getPartnerAgreement, listClientOrgs } from "@xos/data/partner";
import { listProjects } from "@xos/data/projects";
import { untyped } from "@xos/data/untyped";
import { listTemplates } from "@xos/data/workflow";
import { getFormatter } from "next-intl/server";
import type { ReactNode } from "react";
import { ButtonLink } from "@/components/ui";
import { PLANS } from "@/lib/plans.generated";
import { getTranslate } from "@/lib/shell/translate";
import type { SettingsContribution, SettingsPanelProps } from "./types";

/**
 * A61's settings panels (RRR-106): the Partner console entry on Settings > Partner for partner
 * agencies (A59-020), the org's real usage against its plan on Settings > Usage, and the org's
 * project templates on Settings > Templates (A59-032). Each reads with the viewer's client, so row
 * level security decides what appears.
 */

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex max-w-layout-form flex-col gap-12">
      <header className="flex flex-col gap-4">
        <h2 id={id} className="m-0 text-heading-16 font-semibold">
          {title}
        </h2>
        <p className="m-0 text-text-13 text-text-secondary">{description}</p>
      </header>
      {children}
    </section>
  );
}

function Facts({ rows }: { rows: readonly (readonly [string, string])[] }) {
  return (
    <dl className="m-0 grid grid-cols-1 gap-x-16 gap-y-8 text-text-13 sm:grid-cols-[minmax(0,14rem)_1fr]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-text-secondary">{label}</dt>
          <dd className="m-0 font-medium tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Settings > Partner: the way into the Partner console for a partner agency's Owners and Admins. */
async function PartnerPanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  const format = await getFormatter();
  const [clients, agreement] = await Promise.all([
    listClientOrgs(ctx.viewer.db, ctx.org.id),
    getPartnerAgreement(ctx.viewer.db, ctx.org.id),
  ]);
  const count = clients.ok ? clients.data.length : 0;
  const terms = agreement.ok ? agreement.data : null;
  return (
    <Section
      id="settings-partner-console"
      title={t("shell.settings.partnerConsole.title")}
      description={t("shell.settings.partnerConsole.lead", { org: ctx.org.name })}
    >
      <Facts
        rows={[
          [t("shell.settings.partnerConsole.clientOrgs"), format.number(count)],
          ...(terms
            ? ([
                [
                  t("shell.settings.partnerConsole.discount"),
                  format.number(terms.discountBps / 10000, { style: "percent" }),
                ],
              ] as const)
            : []),
        ]}
      />
      <div>
        <ButtonLink href={`/partner/${ctx.org.slug}`} variant="primary">
          {count === 0
            ? t("shell.settings.partnerConsole.createFirst")
            : t("shell.settings.partnerConsole.open")}
        </ButtonLink>
      </div>
    </Section>
  );
}

/** Active external engagements of the org now, read under the reader's row level security. */
async function activeEngagements(ctx: SettingsPanelProps["ctx"]): Promise<number | null> {
  const { count, error } = await untyped(ctx.viewer.db)
    .from("engagement_board")
    .select("engagement_id", { count: "exact", head: true })
    .eq("org_id", ctx.org.id)
    .eq("engagement_state", "Active");
  return error ? null : (count ?? 0);
}

/**
 * Settings > Usage (A59-032): seats, field members, active projects and active engagements against
 * the plan's allowances, from the same sources as the People directory banner and Billing and Plan.
 */
async function UsagePanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  const format = await getFormatter();
  const db = ctx.viewer.db;
  const [seats, subscription, members, projects, engagements] = await Promise.all([
    getSeatUsage(db, ctx.org.id),
    getSubscription(db, ctx.org.id),
    listMembers(db, ctx.org.id),
    listProjects(db, ctx.org.id, { includeArchived: false }),
    activeEngagements(ctx),
  ]);
  const plan = subscription.ok ? PLANS.find((p) => p.code === subscription.data.planCode) : null;
  const limits: Readonly<Record<string, number | null>> = plan?.limits ?? {};
  const against = (used: number, limit: number | null | undefined) =>
    limit === null || limit === undefined
      ? t("shell.settings.usagePanel.unlimited", { used: format.number(used) })
      : t("shell.settings.usagePanel.ofLimit", {
          used: format.number(used),
          limit: format.number(limit),
        });
  const field = members.ok
    ? members.data.filter((m) => m.roles.some((r) => r.code === "field")).length
    : null;
  const active = projects.ok
    ? projects.data.filter((p) => p.projectState !== "Complete" && p.projectState !== "Canceled")
        .length
    : null;
  const rows: (readonly [string, string])[] = [];
  if (seats.ok) {
    rows.push([t("shell.settings.usagePanel.seats"), against(seats.data.used, seats.data.limit)]);
  }
  if (field !== null) {
    rows.push([t("shell.settings.usagePanel.field"), against(field, limits["field_members"])]);
  }
  if (active !== null) {
    rows.push([
      t("shell.settings.usagePanel.projects"),
      against(active, limits["active_projects"]),
    ]);
  }
  if (engagements !== null) {
    rows.push([
      t("shell.settings.usagePanel.engagements"),
      against(engagements, limits["active_external_engagements_per_month"]),
    ]);
  }
  return (
    <Section
      id="settings-usage-now"
      title={t("shell.settings.usagePanel.title")}
      description={
        plan
          ? t("shell.settings.usagePanel.lead", {
              org: ctx.org.name,
              plan: t(`shell.plans.${plan.code}.name`),
            })
          : t("shell.settings.usagePanel.leadNoPlan", { org: ctx.org.name })
      }
    >
      <Facts rows={rows} />
      <div className="flex flex-wrap gap-8">
        <ButtonLink href={`/${ctx.org.slug}/people/directory`}>
          {t("shell.settings.usagePanel.members")}
        </ButtonLink>
        {ctx.role === "owner" ? (
          <ButtonLink href={`/${ctx.org.slug}/settings/billing-and-plan`}>
            {t("shell.settings.usagePanel.billing")}
          </ButtonLink>
        ) : null}
      </div>
    </Section>
  );
}

/** Settings > Templates (A59-032): the org's project templates, managed on Projects > Templates. */
async function TemplatesPanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  const templates = await listTemplates(ctx.viewer.db, ctx.org.id);
  const list = templates.ok ? templates.data : [];
  const href = `/${ctx.org.slug}/projects/templates`;
  return (
    <Section
      id="settings-templates-projects"
      title={t("shell.settings.templatesPanel.title")}
      description={t("shell.settings.templatesPanel.lead")}
    >
      {list.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">
          {t("shell.settings.templatesPanel.empty")}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
          {list.map((template) => {
            const current =
              template.versions.find((v) => v.id === template.currentVersionId) ??
              template.versions[0];
            return (
              <li key={template.id} className="flex flex-col gap-2 py-8">
                <a
                  href={`${href}?template=${template.id}`}
                  className="font-medium text-accent-text no-underline hover:underline"
                >
                  {template.name}
                </a>
                <span className="text-text-13 text-text-secondary">
                  {t("shell.settings.templatesPanel.line", {
                    version: current?.number ?? 0,
                    items: current?.items.length ?? 0,
                    projects: template.applications,
                  })}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <div>
        <ButtonLink href={href}>{t("shell.settings.templatesPanel.open")}</ButtonLink>
      </div>
    </Section>
  );
}

export const contributions: readonly SettingsContribution[] = [
  { node: "settings.partner", order: 10, Panel: PartnerPanel },
  { node: "settings.usage", order: 10, Panel: UsagePanel },
  { node: "settings.templates", order: 10, Panel: TemplatesPanel },
];
