import { listAssetClasses, listAssetUnits } from "@xos/data/assets";
import {
  listMaintenanceDue,
  MAINTENANCE_DUE_STATUSES,
  MAINTENANCE_INTERVAL_UNITS,
  type MaintenanceDueStatus,
} from "@xos/data/asset-maintenance-plans";
import type { Route } from "next";
import Link from "next/link";
import { getFormatter } from "next-intl/server";
import { PageHeader } from "@/components/collection-kit/ui";
import { CollectionPage } from "@/components/platform/collection-page";
import { assetCapabilities, must } from "@/lib/assets/context";
import { DEFAULT_CURRENCY } from "@/lib/assets/page";
import type { OrgContext } from "@/lib/shell/context";
import { orgToday } from "@/lib/shell/time-zone";
import { getTranslate } from "@/lib/shell/translate";
import { CompletePlanButton, PlanCreateButton } from "./maintenance-plan-actions";

const STATUS_KEY: Record<MaintenanceDueStatus, string> = {
  Pending: "pending",
  Overdue: "overdue",
  Completed: "completed",
};

/**
 * Assets > Maintenance, Schedule (B11, G-95): one row per plan and unit with its computed due date and status, on the
 * org's calendar. Add plan is the section's primary action; Complete opens the maintenance form with the plan set, so
 * the work moves the next due date. Nothing is stored here: done work is the log.
 */
export async function MaintenanceSchedule({
  ctx,
  search,
}: {
  ctx: OrgContext;
  search: Record<string, string | string[] | undefined>;
}) {
  const t = await getTranslate();
  const format = await getFormatter();
  const db = ctx.viewer.db;
  const can = assetCapabilities(ctx);
  const [dueResult, unitsResult, classesResult, today] = await Promise.all([
    listMaintenanceDue(db, { orgId: ctx.org.id }),
    listAssetUnits(db, ctx.org.id),
    listAssetClasses(db, ctx.org.id),
    orgToday(ctx),
  ]);
  const due = must(dueResult, "maintenance schedule");
  const units = must(unitsResult, "asset units");
  const classes = must(classesResult, "asset classes");
  const asked = typeof search["status"] === "string" ? search["status"] : "";
  const status = (MAINTENANCE_DUE_STATUSES as readonly string[]).includes(asked)
    ? (asked as MaintenanceDueStatus)
    : null;
  const shown = status ? due.filter((d) => d.status === status) : due;
  const day = (iso: string | null) =>
    iso
      ? format.dateTime(new Date(`${iso}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" })
      : t("assets.schedule.noDate");
  const path = `/${ctx.org.slug}/assets/maintenance`;
  const appliesTo = [
    ...units.map((u) => ({ value: `unit:${u.id}`, label: `${u.assetTag} · ${u.className}` })),
    ...classes.map((c) => ({
      value: `class:${c.id}`,
      label: t("assets.schedule.everyUnitOf", { name: c.name }),
    })),
  ];
  return (
    <CollectionPage
      header={
        <PageHeader
          title={t("assets.schedule.title")}
          actions={
            can.maintenance && appliesTo.length > 0 ? (
              <PlanCreateButton
                org={ctx.org.slug}
                appliesTo={appliesTo}
                units={MAINTENANCE_INTERVAL_UNITS.map((u) => ({
                  value: u,
                  label: t(`assets.schedule.intervals.${u}`),
                }))}
                today={today}
              />
            ) : null
          }
        />
      }
    >
      <nav
        aria-label={t("assets.schedule.filterLabel")}
        className="flex flex-wrap gap-12 text-text-13"
      >
        <Link
          href={path as Route}
          aria-current={status === null ? "page" : undefined}
          className="text-accent-text underline"
        >
          {t("assets.schedule.all")}
        </Link>
        {MAINTENANCE_DUE_STATUSES.map((s) => (
          <Link
            key={s}
            href={`${path}?status=${encodeURIComponent(s)}` as Route}
            aria-current={status === s ? "page" : undefined}
            className="text-accent-text underline"
          >
            {t(`assets.schedule.statuses.${STATUS_KEY[s]}`)}
          </Link>
        ))}
      </nav>
      {shown.length === 0 ? (
        <p className="m-0 text-text-14 text-text-secondary">{t("assets.schedule.empty")}</p>
      ) : (
        <ul
          aria-label={t("assets.schedule.title")}
          className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0"
        >
          {shown.map((d) => (
            <li
              key={`${d.planId}-${d.unitId}`}
              className="flex flex-wrap items-center justify-between gap-12 py-12 text-text-13"
            >
              <div className="flex min-w-0 flex-col gap-2">
                <span className="font-medium">{t("assets.schedule.rowTitle", { title: d.title, tag: d.assetTag })}</span>
                <span className="text-text-12 text-text-secondary">
                  {t("assets.schedule.line", {
                    status: t(`assets.schedule.statuses.${STATUS_KEY[d.status]}`),
                    due: day(d.dueOn),
                    last: day(d.lastPerformedOn),
                  })}
                </span>
                {d.instructions ? <span>{d.instructions}</span> : null}
              </div>
              {can.maintenance && d.status !== "Completed" ? (
                <CompletePlanButton
                  org={ctx.org.slug}
                  unitId={d.unitId}
                  unitLabel={d.assetTag}
                  planId={d.planId}
                  planTitle={d.title}
                  currency={DEFAULT_CURRENCY}
                  today={today}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </CollectionPage>
  );
}
