import {
  can,
  getOrgDetail,
  listActionLog,
  type OrgDetail,
  type PlanOverride,
} from "@xos/data/console";
import type { Metadata, Route } from "next";
import NextLink from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { ActionForm } from "@/components/action-form";
import { ExpiryField, OnOffField, ReasonField } from "@/components/fields";
import { Empty, Facts, PageHeader, Panel, Section, Table } from "@/components/page";
import { Input, Select } from "@/components/ui";
import {
  clearFlagOverrideAction,
  endPlanOverrideAction,
  setFlagOverrideAction,
  setPlanOverrideAction,
} from "@/lib/actions/tenants";
import { getConsoleFormat, type ConsoleFormat } from "@/lib/format";
import { requirePermission } from "@/lib/operator";

const PLANS = ["access", "core", "pro", "team", "enterprise"] as const;

export async function generateMetadata(): Promise<Metadata> {
  const nav = await getTranslations("nav");
  return { title: nav("console.tenant") };
}

function overrideText(o: PlanOverride, f: ConsoleFormat): string {
  const { t, label } = f;
  if (o.kind === "Plan")
    return t("tenant.overridePlan", { plan: label("plans", o.planCode ?? "") });
  if (o.kind === "Feature") {
    return t("tenant.overrideFeature", {
      feature: label("featureNames", o.featureCode ?? ""),
      value: o.featureEnabled ? t("common.on") : t("common.off"),
    });
  }
  return t("tenant.overrideLimit", {
    limit: label("limitNames", o.limitCode ?? ""),
    value: o.limitValue === null ? t("common.unlimited") : f.number(o.limitValue),
  });
}

/**
 * One tenant (A90, Section 4.10): plan in force and subscription, status, usage this month, limits, features and
 * flags, plan overrides, Owners, support sessions and the console's own actions on it. Billing and identity facts
 * only: records open through a support session.
 */
export default async function TenantPage({ params }: PageProps<"/tenants/[orgId]">) {
  const { orgId } = await params;
  if (!z.uuid().safeParse(orgId).success) notFound();
  const ctx = await requirePermission("tenants.read");
  const [detail, log, f] = await Promise.all([
    getOrgDetail(ctx.db, orgId),
    listActionLog(ctx.db, { orgId, limit: 25 }),
    getConsoleFormat(),
  ]);
  if (!detail.ok) {
    if (detail.error.kind === "not-found") notFound();
    throw new Error(`Cannot read the org: ${detail.error.kind}`);
  }
  const d: OrgDetail = detail.data;
  const { t, label, instant, number } = f;
  const plansWrite = can(ctx.operator, "plans.write");
  const flagsWrite = can(ctx.operator, "flags.write");
  const supportSessions = can(ctx.operator, "support.sessions");
  return (
    <>
      <PageHeader title={d.org.name} intro={d.org.slug} />

      <Section id="summary" title={t("tenant.summary")}>
        <Panel>
          <Facts
            items={[
              {
                label: t("tenant.planInForce"),
                value: <span data-testid="plan-in-force">{label("plans", d.planCode)}</span>,
              },
              {
                label: t("tenant.subscription"),
                value: d.subscription
                  ? [
                      `${label("plans", d.subscription.planCode)}, ${label("subscription", d.subscription.state)}`,
                      d.subscription.grandfathered
                        ? t("tenant.grandfathered")
                        : t("tenant.extraSeats", { count: d.subscription.extraSeats }),
                    ].join(" · ")
                  : t("subscription.none"),
              },
              {
                label: t("tenant.status"),
                value: d.cancellation
                  ? t("tenant.readOnlyUntil", {
                      until: instant(d.cancellation.readOnlyUntil),
                      purge: instant(d.cancellation.purgeAfter),
                    })
                  : t("tenant.activeStatus"),
              },
              { label: t("tenant.created"), value: instant(d.org.createdAt) },
              ...(d.org.parent ? [{ label: t("tenant.partner"), value: d.org.parent.name }] : []),
              ...(d.org.clientCount > 0
                ? [
                    {
                      label: t("tenant.partner"),
                      value: t("tenant.clients", { count: d.org.clientCount }),
                    },
                  ]
                : []),
              {
                label: t("tenant.owners"),
                value:
                  d.owners.length === 0
                    ? t("common.none")
                    : d.owners
                        .map((o) => `${o.name ?? t("common.unknownPerson")} (${o.email ?? ""})`)
                        .join(", "),
              },
            ]}
          />
        </Panel>
      </Section>

      <Section
        id="usage"
        title={t("tenant.usage")}
        intro={t("tenant.monthStart", { date: instant(d.usage.monthStart) })}
      >
        <Facts
          items={[
            { label: t("tenant.seats"), value: number(d.usage.seats) },
            { label: t("tenant.fieldMembers"), value: number(d.usage.fieldMembers) },
            { label: t("tenant.activeProjects"), value: number(d.usage.activeProjects) },
          ]}
        />
        {d.usage.meters.length === 0 ? (
          <Empty>{t("tenant.noMeters")}</Empty>
        ) : (
          <Table
            caption={t("tenant.usage")}
            columns={[t("tenant.meter"), t("tenant.quantity")]}
            rows={d.usage.meters.map((m) => ({
              key: m.meterCode,
              cells: [m.meterCode, number(m.quantity)],
            }))}
          />
        )}
        <Table
          caption={t("tenant.limits")}
          testId="limits"
          columns={[t("tenant.limit"), t("tenant.inForce"), t("tenant.planValue")]}
          rows={d.limits.map((l) => ({
            key: l.limitCode,
            cells: [
              label("limitNames", l.limitCode),
              l.limitValue === null ? t("common.unlimited") : number(l.limitValue),
              l.planValue === null ? t("common.unlimited") : number(l.planValue),
            ],
          }))}
        />
      </Section>

      <Section id="features" title={t("tenant.features")}>
        <Table
          caption={t("tenant.features")}
          columns={[t("tenant.feature"), t("tenant.inPlan"), t("tenant.enabled")]}
          rows={d.features.map((x) => ({
            key: x.featureCode,
            cells: [
              label("featureNames", x.featureCode),
              x.inPlan ? t("common.yes") : t("common.no"),
              x.enabled ? t("common.on") : t("common.off"),
            ],
          }))}
        />
      </Section>

      <Section
        id="plan-overrides"
        title={t("tenant.planOverrides")}
        intro={t("tenant.planOverridesIntro")}
      >
        {d.planOverrides.length === 0 ? (
          <Empty>{t("tenant.noOverrides")}</Empty>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-8 p-0" data-testid="plan-overrides">
            {d.planOverrides.map((o) => (
              <li
                key={o.id}
                className="flex flex-col gap-8 rounded-card border border-border-subtle p-12"
              >
                <span className="flex flex-wrap gap-8 text-text-13">
                  <span className="font-medium">{overrideText(o, f)}</span>
                  <span className="text-text-secondary">
                    {o.live ? t("common.live") : t("common.ended")}
                  </span>
                </span>
                <span className="text-text-12 text-text-secondary">
                  {t("tenant.overrideWindow", {
                    from: instant(o.startsAt),
                    until: instant(o.expiresAt),
                    name: o.setBy ?? t("common.unknownPerson"),
                  })}
                </span>
                <span className="text-text-12">{o.reason}</span>
                {o.endedAt ? (
                  <span className="text-text-12 text-text-secondary">
                    {t("tenant.overrideEnded", {
                      when: instant(o.endedAt),
                      reason: o.endReason ?? "",
                    })}
                  </span>
                ) : null}
                {o.live && plansWrite ? (
                  <ActionForm
                    action={endPlanOverrideAction}
                    hidden={{ orgId: d.org.id, overrideId: o.id }}
                    submitLabel={t("tenant.endOverride")}
                    successLabel={t("tenant.overrideEndedOk")}
                    variant="secondary"
                    label={t("tenant.endOverride")}
                  >
                    <ReasonField t={t} id={`end-override-${o.id}`} />
                  </ActionForm>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {plansWrite ? (
          <div className="grid grid-cols-1 gap-16 lg:grid-cols-3">
            <Panel>
              <h3 className="m-0 text-text-14 font-semibold">{t("tenant.newPlanOverride")}</h3>
              <ActionForm
                action={setPlanOverrideAction}
                hidden={{ orgId: d.org.id, kind: "Plan" }}
                submitLabel={t("tenant.newPlanOverride")}
                successLabel={t("tenant.overrideSaved")}
                label={t("tenant.newPlanOverride")}
                testId="plan-override-form"
              >
                <Select
                  id="override-plan"
                  name="planCode"
                  label={t("tenant.planInForce")}
                  value="pro"
                  options={PLANS.map((p) => ({ value: p, label: t(`plans.${p}`) }))}
                />
                <ExpiryField t={t} id="override-plan-days" />
                <ReasonField t={t} id="override-plan-reason" />
              </ActionForm>
            </Panel>
            <Panel>
              <h3 className="m-0 text-text-14 font-semibold">{t("tenant.newFeatureOverride")}</h3>
              <ActionForm
                action={setPlanOverrideAction}
                hidden={{ orgId: d.org.id, kind: "Feature" }}
                submitLabel={t("tenant.newFeatureOverride")}
                successLabel={t("tenant.overrideSaved")}
                label={t("tenant.newFeatureOverride")}
              >
                <Select
                  id="override-feature"
                  name="featureCode"
                  label={t("tenant.feature")}
                  value={d.features[0]?.featureCode ?? ""}
                  options={d.features.map((x) => ({
                    value: x.featureCode,
                    label: label("featureNames", x.featureCode),
                  }))}
                />
                <OnOffField t={t} id="override-feature-enabled" />
                <ExpiryField t={t} id="override-feature-days" />
                <ReasonField t={t} id="override-feature-reason" />
              </ActionForm>
            </Panel>
            <Panel>
              <h3 className="m-0 text-text-14 font-semibold">{t("tenant.newLimitOverride")}</h3>
              <ActionForm
                action={setPlanOverrideAction}
                hidden={{ orgId: d.org.id, kind: "Limit" }}
                submitLabel={t("tenant.newLimitOverride")}
                successLabel={t("tenant.overrideSaved")}
                label={t("tenant.newLimitOverride")}
              >
                <Select
                  id="override-limit"
                  name="limitCode"
                  label={t("tenant.limit")}
                  value={d.limits[0]?.limitCode ?? ""}
                  options={d.limits.map((l) => ({
                    value: l.limitCode,
                    label: label("limitNames", l.limitCode),
                  }))}
                />
                <Input
                  id="override-limit-value"
                  name="limitValue"
                  type="number"
                  min={0}
                  step={1}
                  label={t("tenant.limitValue")}
                  help={t("tenant.limitValueHelp")}
                />
                <ExpiryField t={t} id="override-limit-days" />
                <ReasonField t={t} id="override-limit-reason" />
              </ActionForm>
            </Panel>
          </div>
        ) : null}
      </Section>

      <Section id="flags" title={t("tenant.flags")}>
        <ul className="m-0 flex list-none flex-col gap-8 p-0" data-testid="tenant-flags">
          {d.flags.map((flag) => (
            <li
              key={flag.flagKey}
              data-flag={flag.flagKey}
              className="flex flex-col gap-8 rounded-card border border-border-subtle p-12"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-8">
                <span className="flex flex-col gap-4">
                  <code className="font-mono text-text-13">{flag.flagKey}</code>
                  <span className="text-text-12 text-text-secondary">{flag.description}</span>
                </span>
                <span className="text-text-13 font-medium" data-testid="flag-state">
                  {flag.killSwitch
                    ? t("tenant.killed")
                    : flag.enabled
                      ? t("common.on")
                      : t("common.off")}
                </span>
              </div>
              {flag.override ? (
                <span className="text-text-12 text-text-secondary">
                  {flag.override.expiresAt
                    ? t("tenant.overrideBy", {
                        value: flag.override.enabled ? t("common.on") : t("common.off"),
                        until: instant(flag.override.expiresAt),
                        name: flag.override.setBy ?? t("common.unknownPerson"),
                        reason: flag.override.reason,
                      })
                    : t("tenant.overrideNoExpiry", {
                        value: flag.override.enabled ? t("common.on") : t("common.off"),
                        name: flag.override.setBy ?? t("common.unknownPerson"),
                        reason: flag.override.reason,
                      })}
                </span>
              ) : null}
              {flagsWrite ? (
                <details>
                  <summary className="cursor-pointer text-text-13 text-accent-text">
                    {t("tenant.setFlag")}
                  </summary>
                  <div className="flex flex-col gap-12 pt-12">
                    <ActionForm
                      action={setFlagOverrideAction}
                      hidden={{ orgId: d.org.id, flagKey: flag.flagKey }}
                      submitLabel={t("tenant.setFlag")}
                      successLabel={t("tenant.flagSaved")}
                      label={`${t("tenant.setFlag")} ${flag.flagKey}`}
                    >
                      <OnOffField t={t} id={`flag-${flag.flagKey}-enabled`} />
                      <ExpiryField t={t} id={`flag-${flag.flagKey}-days`} />
                      <ReasonField t={t} id={`flag-${flag.flagKey}-reason`} maxLength={300} />
                    </ActionForm>
                    {flag.override ? (
                      <ActionForm
                        action={clearFlagOverrideAction}
                        hidden={{ orgId: d.org.id, overrideId: flag.override.id }}
                        submitLabel={t("tenant.clearFlag")}
                        successLabel={t("tenant.flagCleared")}
                        variant="secondary"
                        label={`${t("tenant.clearFlag")} ${flag.flagKey}`}
                      >
                        <ReasonField t={t} id={`flag-${flag.flagKey}-clear`} maxLength={300} />
                      </ActionForm>
                    ) : null}
                  </div>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      </Section>

      <Section id="support" title={t("tenant.supportSessions")}>
        {d.supportSessions.length === 0 ? (
          <Empty>{t("tenant.noSessions")}</Empty>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-8 p-0">
            {d.supportSessions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-8 text-text-13">
                <span>
                  {s.granteeOrgName
                    ? t("tenant.sessionPartner", { partner: s.granteeOrgName, reason: s.reason })
                    : t("tenant.sessionPlatform", { reason: s.reason })}
                </span>
                <span className="text-text-secondary">
                  {t("tenant.sessionWindow", {
                    from: instant(s.startsAt),
                    to: instant(s.endedAt ?? s.endsAt),
                  })}
                </span>
                {s.open && !s.granteeOrgName && supportSessions ? (
                  <NextLink
                    href={`/support/${s.id}` as Route}
                    className="text-accent-text underline"
                  >
                    {t("tenant.openSession")}
                  </NextLink>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="activity" title={t("tenant.activity")}>
        {!log.ok || log.data.length === 0 ? (
          <Empty>{t("tenant.noActivity")}</Empty>
        ) : (
          <Table
            caption={t("tenant.activity")}
            columns={[t("common.when"), t("common.who"), t("common.what"), t("activity.reason")]}
            rows={log.data.map((a) => ({
              key: a.id,
              cells: [
                instant(a.actedAt),
                a.operatorName ?? t("common.unknownPerson"),
                label("actionNames", a.action.replace(/\./g, "_")),
                a.reason ?? "",
              ],
            }))}
          />
        )}
      </Section>
    </>
  );
}
