import {
  getPlanLimitUsage,
  listPlanLimitCandidates,
  type PlanLimitCandidate,
  type PlanLimitUsage,
} from "@xos/data/plan-limits";
import { getTranslations } from "next-intl/server";
import { PlanLimitChoiceForm, type PlanLimitOption } from "@/components/settings/a107-forms";
import { Card, InlineAlert } from "@/components/ui";
import { getTranslate } from "@/lib/shell/translate";
import type { SettingsContribution, SettingsPanelProps } from "./types";

/**
 * A107's panel on Settings, Billing and Plan (RRR-152, ADR 0081; Section 16): what stays writable when the org is over
 * its plan's limits. For each limit that counts standing objects (active projects, seats, field seats) it shows the
 * count against the limit and, past the limit, the projects or members it counts in the order of the selection rule,
 * each writable or read-only. The Owner (org.billing.manage) chooses which stay writable; other billing readers see the
 * same list. Owners' seats are always writable. Reads with the viewer's session; app.choose_plan_limit_keeps decides.
 */

type T = (key: string, values?: Record<string, string | number>) => string;

function option(
  limit: PlanLimitUsage["limit"],
  c: PlanLimitCandidate,
  t: T,
  translate: T,
): PlanLimitOption {
  const role = c.roleName ?? (c.roleCode ? translate(`shell.roles.${c.roleCode}`) : null);
  return {
    id: c.id,
    label: c.label ?? t("panel.unnamed"),
    detail: limit === "active_projects" ? c.projectKey : role,
    locked: c.locked,
    readOnly: c.readOnly,
  };
}

async function PlanLimitsPanel({ ctx }: SettingsPanelProps) {
  if (!ctx.capabilities.has("org.billing.read")) return null;
  const db = ctx.viewer.db;
  const [usage, rawT, translate] = await Promise.all([
    getPlanLimitUsage(db, ctx.org.id),
    getTranslations("planLimits"),
    getTranslate(),
  ]);
  const t = rawT as unknown as T;
  if (!usage.ok) return <InlineAlert tone="danger">{t("errors.unexpected")}</InlineAlert>;
  const over = usage.data.filter((u) => u.limitValue !== null && u.inUse > u.limitValue);
  const candidates = new Map(
    await Promise.all(
      over.map(
        async (u) => [u.limit, await listPlanLimitCandidates(db, ctx.org.id, u.limit)] as const,
      ),
    ),
  );
  const manage = ctx.capabilities.has("org.billing.manage");
  const planCode = usage.data[0]?.planCode ?? "access";
  const plan = translate(`shell.plans.${planCode}.name`);
  return (
    <Card>
      <section
        id="plan-limits"
        aria-labelledby="plan-limits-title"
        className="flex flex-col gap-12"
        data-testid="plan-limits-panel"
      >
        <header className="flex flex-col gap-4">
          <h2 id="plan-limits-title" className="m-0 text-heading-16 font-semibold">
            {t("panel.title")}
          </h2>
          <p className="m-0 text-text-13 text-text-secondary">{t("panel.description", { plan })}</p>
        </header>
        <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
          {usage.data.map((u) => {
            const listed = candidates.get(u.limit);
            const options = listed?.ok
              ? listed.data.map((c) => option(u.limit, c, t, translate))
              : [];
            const locked = options.filter((o) => o.locked).length;
            const room = u.limitValue === null ? 0 : Math.max(u.limitValue - locked, 0);
            return (
              <li key={u.limit} className="flex flex-col gap-8 py-12">
                <div className="flex flex-wrap items-baseline justify-between gap-8">
                  <h3 className="m-0 text-label-14 font-semibold">{t(`limits.${u.limit}`)}</h3>
                  <span className="text-text-13 text-text-secondary">
                    {u.limitValue === null
                      ? t("panel.unlimited", { plan })
                      : t("panel.usage", { inUse: u.inUse, limit: u.limitValue })}
                  </span>
                </div>
                {u.limitValue === null || u.inUse <= u.limitValue ? (
                  <p className="m-0 text-text-13">{t("panel.within")}</p>
                ) : (
                  <>
                    <p className="m-0 text-text-13">
                      {t("panel.over", { count: u.readOnly })}{" "}
                      {room > 0 ? t("panel.room", { room }) : t("panel.noRoom")}
                    </p>
                    {listed && !listed.ok ? (
                      <InlineAlert tone="danger">{t("errors.unexpected")}</InlineAlert>
                    ) : manage && room > 0 ? (
                      <PlanLimitChoiceForm
                        org={ctx.org.slug}
                        limit={u.limit}
                        legend={t(`limits.${u.limit}`)}
                        options={options}
                        labels={{
                          save: t("panel.save"),
                          owner: t("panel.owner"),
                          readOnly: t("panel.readOnly"),
                          writable: t("panel.writable"),
                        }}
                      />
                    ) : (
                      <>
                        <ul className="m-0 flex list-none flex-col gap-4 p-0 text-text-13">
                          {options.map((o) => (
                            <li key={o.id} className="flex flex-wrap justify-between gap-8">
                              <span>{o.detail ? `${o.label} (${o.detail})` : o.label}</span>
                              <span className="text-text-secondary">
                                {o.locked
                                  ? t("panel.owner")
                                  : o.readOnly
                                    ? t("panel.readOnly")
                                    : t("panel.writable")}
                              </span>
                            </li>
                          ))}
                        </ul>
                        {manage ? null : (
                          <p className="m-0 text-text-12 text-text-secondary">
                            {t("panel.ownerOnly")}
                          </p>
                        )}
                      </>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </Card>
  );
}

export const contributions: readonly SettingsContribution[] = [
  { node: "settings.billing-and-plan", order: 10, Panel: PlanLimitsPanel },
];
