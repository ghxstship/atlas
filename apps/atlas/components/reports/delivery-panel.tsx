import { listMembers } from "@xos/data";
import { listDashboards, listDeliveries, listSchedules } from "@xos/data/dashboards";
import { resolveSettings } from "@xos/data/settings";
import { getLocale, getTranslations } from "next-intl/server";
import { deleteScheduleAction, pauseScheduleAction } from "@/app/[org]/reports/dashboards/actions";
import { InlineActionButton } from "@/components/finance/kit";
import type { OrgContext } from "@/lib/shell/context";
import { AddTileForm, ScheduleForm } from "./dashboards-client";

/**
 * On a saved report (A43, finding A38-004; journey 29): add it to one of the viewer's dashboards, and
 * schedule it by email as PDF, CSV or .xlsx to members of the org, with the schedule's recent emails.
 * Reads go through row level security; the schedule form shows only to someone who may schedule.
 */
export async function ReportDeliveryPanel({
  ctx,
  reportDefinitionId,
  canSchedule,
  canPlace,
}: {
  ctx: OrgContext;
  reportDefinitionId: string;
  canSchedule: boolean;
  canPlace: boolean;
}) {
  const db = ctx.viewer.db;
  const [translate, locale, schedules, dashboards, members, settings] = await Promise.all([
    getTranslations("reporting"),
    getLocale(),
    listSchedules(db, reportDefinitionId),
    listDashboards(db, { orgId: ctx.org.id, membershipId: ctx.org.membershipId }),
    listMembers(db, ctx.org.id),
    resolveSettings(db, { orgId: ctx.org.id }),
  ]);
  const zone = settings.ok ? settings.data.get("locale.time_zone")?.value : null;
  const timeZone = typeof zone === "string" && zone !== "" ? zone : "UTC";
  const t = translate as unknown as (
    key: string,
    values?: Record<string, string | number>,
  ) => string;
  const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const memberName = new Map(
    (members.ok ? members.data : []).map((m) => [m.membershipId, m.fullName ?? ""]),
  );
  const deliveries = await Promise.all(
    (schedules.ok ? schedules.data : []).map((s) => listDeliveries(db, s.id)),
  );
  const org = ctx.org.slug;
  return (
    <div className="flex flex-col gap-16">
      {canPlace ? (
        <section aria-labelledby={`tile-${reportDefinitionId}`} className="flex flex-col gap-8">
          <h3 id={`tile-${reportDefinitionId}`} className="m-0 text-text-14 font-semibold">
            {t("tile.title")}
          </h3>
          {dashboards.ok && dashboards.data.length > 0 ? (
            <AddTileForm
              org={org}
              reportDefinitionId={reportDefinitionId}
              dashboards={dashboards.data.map((d) => ({ value: d.id, label: d.name }))}
            />
          ) : (
            <p className="m-0 text-text-13 text-text-secondary">{t("tile.noDashboards")}</p>
          )}
        </section>
      ) : null}
      <section aria-labelledby={`schedule-${reportDefinitionId}`} className="flex flex-col gap-8">
        <h3 id={`schedule-${reportDefinitionId}`} className="m-0 text-text-14 font-semibold">
          {t("schedule.title")}
        </h3>
        <p className="m-0 text-text-12 text-text-secondary">{t("schedule.sentence")}</p>
        {schedules.ok && schedules.data.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("schedule.none")}</p>
        ) : null}
        {schedules.ok
          ? schedules.data.map((s, i) => {
              const sent = deliveries[i];
              return (
                <div
                  key={s.id}
                  className="flex flex-col gap-6 rounded-card border border-border-subtle p-12 text-text-13"
                >
                  <p className="m-0">
                    {s.pausedAt ? `${t("schedule.paused")} · ` : ""}
                    {t("schedule.summary", {
                      cadence: t(`schedule.cadences.${s.cadence}`),
                      hour: String(s.localHour).padStart(2, "0"),
                      timeZone: s.timeZone,
                      format: s.format,
                      count: s.recipients.length,
                      next: when.format(new Date(s.nextRunAt)),
                    })}
                  </p>
                  <p className="m-0 text-text-12 text-text-secondary">
                    {s.recipients.map((r) => memberName.get(r.membershipId) ?? "").join(", ")}
                  </p>
                  {canSchedule ? (
                    <div className="flex flex-wrap gap-8">
                      <InlineActionButton
                        action={pauseScheduleAction}
                        fields={{ org, id: s.id, paused: s.pausedAt ? "0" : "1" }}
                        label={s.pausedAt ? t("schedule.resume") : t("schedule.pause")}
                      />
                      <InlineActionButton
                        action={deleteScheduleAction}
                        fields={{ org, id: s.id }}
                        label={t("schedule.remove")}
                        icon="Trash2"
                      />
                    </div>
                  ) : null}
                  {sent?.ok && sent.data.length > 0 ? (
                    <ul
                      className="m-0 flex list-none flex-col gap-2 p-0 text-text-12 text-text-secondary"
                      aria-label={t("schedule.deliveries")}
                    >
                      {sent.data.slice(0, 5).map((d) => (
                        <li key={d.id}>
                          {when.format(new Date(d.scheduledFor))} ·{" "}
                          {memberName.get(d.membershipId) ?? ""} ·{" "}
                          {t(`schedule.deliveryStatus.${d.status}`)}
                          {d.lastError ? ` · ${d.lastError}` : ""}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              );
            })
          : null}
        {!canSchedule ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("schedule.needsCapability")}</p>
        ) : !members.ok || members.data.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("schedule.noMembers")}</p>
        ) : (
          <ScheduleForm
            org={org}
            reportDefinitionId={reportDefinitionId}
            timeZone={timeZone}
            members={members.data.map((m) => ({
              value: m.membershipId,
              label: m.fullName ?? m.membershipId,
            }))}
          />
        )}
      </section>
    </div>
  );
}
