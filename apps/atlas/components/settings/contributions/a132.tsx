import { Input, Select } from "@xos/ui";
import {
  getMyAvailabilityStatus,
  listAvailabilityPeriods,
  listShiftTemplates,
} from "@xos/data/crew";
import { getFormatter } from "next-intl/server";
import {
  addAvailabilityAction,
  createShiftTemplateAction,
  removeAvailabilityAction,
  trashShiftTemplateAction,
} from "@/app/[org]/crew/scheduling-actions";
import { CrewInlineForm } from "@/components/crew/inline-form";
import { InlineAlert } from "@/components/ui";
import { getRoleTitles } from "@/lib/crew/context";
import { getTranslate } from "@/lib/shell/translate";
import type { SettingsContribution, SettingsPanelProps } from "./types";

/**
 * A132's settings panels (RRR-194, migrations 2250 and 2251, ADR 0063):
 *   Settings, Scheduling   the org's shift templates (role, call and wrap, headcount, break), which planners lay
 *                          onto days from the crew schedule; kept by holders of org.scheduling.write and read by
 *                          every member. The availability window is the registry settings above.
 *   Me, Work details       the member's availability for the org: the window the org asks for, the days still
 *                          unstated, their periods, and a form to state one. The database locks the notice period.
 * Both read with the viewer's client, so row level security and the RPCs decide what shows.
 */
async function ShiftTemplatesPanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  const [templates, roles] = await Promise.all([
    listShiftTemplates(ctx.viewer.db, ctx.org.id),
    getRoleTitles(ctx),
  ]);
  const canEdit = ctx.capabilities.has("org.scheduling.write");
  const roleName = (code: string | null) =>
    code === null ? t("crew.common.noRole") : (roles.get(code)?.title ?? code);
  return (
    <section
      aria-labelledby="shift-templates"
      className="flex flex-col gap-12"
      data-testid="shift-templates"
    >
      <header className="flex flex-col gap-4">
        <h2 id="shift-templates" className="m-0 text-heading-16 font-semibold">
          {t("crew.scheduling.templates.title")}
        </h2>
        <p className="m-0 text-text-secondary">{t("crew.scheduling.templates.description")}</p>
      </header>
      {!templates.ok ? (
        <InlineAlert tone="danger">{t("crew.scheduling.templates.loadFailed")}</InlineAlert>
      ) : templates.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">
          {t(canEdit ? "crew.scheduling.templates.emptyEditor" : "crew.scheduling.templates.empty")}
        </p>
      ) : (
        <div
          role="region"
          aria-label={t("crew.scheduling.templates.title")}
          tabIndex={0}
          className="overflow-x-auto"
        >
          <table className="w-full border-collapse text-text-13">
            <caption className="sr-only">{t("crew.scheduling.templates.title")}</caption>
            <thead>
              <tr className="text-text-12 text-text-secondary">
                <th scope="col" className="py-6 pe-12 text-start font-medium">
                  {t("crew.scheduling.templates.name")}
                </th>
                <th scope="col" className="py-6 pe-12 text-start font-medium">
                  {t("crew.fields.role")}
                </th>
                <th scope="col" className="py-6 pe-12 text-start font-medium">
                  {t("crew.scheduling.templates.hours")}
                </th>
                <th scope="col" className="py-6 pe-12 text-end font-medium">
                  {t("crew.scheduling.templates.headcount")}
                </th>
                <th scope="col" className="py-6 pe-12 text-end font-medium">
                  {t("crew.scheduling.templates.break")}
                </th>
                {canEdit ? (
                  <th scope="col" className="py-6 text-end font-medium">
                    <span className="sr-only">{t("crew.scheduling.templates.actions")}</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {templates.data.map((tp) => (
                <tr key={tp.id} className="border-t border-border-subtle">
                  <th scope="row" className="py-6 pe-12 text-start font-medium">
                    {tp.name}
                  </th>
                  <td className="py-6 pe-12">{roleName(tp.roleCode)}</td>
                  <td className="py-6 pe-12 tabular-nums">
                    {t(
                      tp.wrapTime <= tp.callTime
                        ? "crew.scheduling.templates.spanOvernight"
                        : "crew.scheduling.templates.span",
                      { call: tp.callTime, wrap: tp.wrapTime },
                    )}
                  </td>
                  <td className="py-6 pe-12 text-end tabular-nums">{tp.headcount}</td>
                  <td className="py-6 pe-12 text-end tabular-nums">
                    {t("crew.scheduling.templates.minutes", { minutes: tp.breakMinutes })}
                  </td>
                  {canEdit ? (
                    <td className="py-6 text-end">
                      <CrewInlineForm
                        action={trashShiftTemplateAction}
                        hidden={{ org: ctx.org.slug, id: tp.id }}
                        submitLabel={t("crew.scheduling.templates.trash")}
                        label={t("crew.scheduling.templates.trashLabel", { name: tp.name })}
                        variant="ghost"
                        layout="inline"
                      />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canEdit ? (
        <CrewInlineForm
          action={createShiftTemplateAction}
          hidden={{ org: ctx.org.slug }}
          submitLabel={t("crew.scheduling.templates.add")}
          successMessage={t("crew.scheduling.templates.added")}
          label={t("crew.scheduling.templates.addLabel")}
          layout="inline"
          resetOnSuccess
        >
          <Input
            id="template-name"
            name="name"
            label={t("crew.scheduling.templates.name")}
            required
            maxLength={120}
          />
          <Select
            id="template-role"
            name="roleCode"
            label={t("crew.fields.role")}
            value=""
            options={[
              { value: "", label: t("crew.common.noRole") },
              ...[...roles.values()].map((r) => ({
                value: r.code,
                label: `${r.code} · ${r.title}`,
              })),
            ]}
          />
          <Input
            id="template-call"
            name="callTime"
            type="time"
            label={t("crew.scheduling.templates.call")}
            defaultValue="08:00"
            required
            width={140}
          />
          <Input
            id="template-wrap"
            name="wrapTime"
            type="time"
            label={t("crew.scheduling.templates.wrap")}
            defaultValue="16:00"
            required
            width={140}
          />
          <Input
            id="template-headcount"
            name="headcount"
            type="number"
            min={1}
            max={50}
            label={t("crew.scheduling.templates.headcount")}
            defaultValue="1"
            required
            width={120}
          />
          <Input
            id="template-break"
            name="breakMinutes"
            type="number"
            min={0}
            max={1440}
            label={t("crew.scheduling.templates.breakField")}
            defaultValue="30"
            required
            width={140}
          />
        </CrewInlineForm>
      ) : null}
    </section>
  );
}

async function MyAvailabilityPanel({ ctx }: SettingsPanelProps) {
  const status = await getMyAvailabilityStatus(ctx.viewer.db, ctx.org.id);
  // Only members state availability for the org; anyone else sees nothing here.
  if (!status.ok) return null;
  const [t, format] = await Promise.all([getTranslate(), getFormatter()]);
  const s = status.data;
  const periods = s.calendarId
    ? await listAvailabilityPeriods(ctx.viewer.db, s.calendarId, new Date().toISOString())
    : null;
  const day = (d: string) =>
    format.dateTime(new Date(`${d}T12:00:00Z`), { timeZone: "UTC", dateStyle: "medium" });
  const at = (iso: string) =>
    format.dateTime(new Date(iso), {
      timeZone: s.timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  const first = s.unstatedDays[0];
  const last = s.unstatedDays[s.unstatedDays.length - 1];
  return (
    <section
      aria-labelledby="my-availability"
      className="flex flex-col gap-12"
      data-testid="my-availability"
    >
      <header className="flex flex-col gap-4">
        <h2 id="my-availability" className="m-0 text-heading-16 font-semibold">
          {t("crew.scheduling.availability.title", { org: ctx.org.name })}
        </h2>
        <p className="m-0 text-text-secondary">
          {s.required
            ? t("crew.scheduling.availability.required", {
                horizon: s.horizonDays,
                notice: s.noticeDays,
              })
            : t("crew.scheduling.availability.optional")}
        </p>
        <p className="m-0 text-text-12 text-text-secondary">
          {t("crew.scheduling.availability.zone", { zone: s.timeZone })}
        </p>
      </header>
      {first && last ? (
        <InlineAlert tone={s.required ? "warning" : "info"}>
          {t("crew.scheduling.availability.unstated", {
            count: s.unstatedDays.length,
            from: day(first),
            to: day(last),
          })}
        </InlineAlert>
      ) : null}
      {periods && periods.ok && periods.data.length > 0 ? (
        <ul
          aria-label={t("crew.scheduling.availability.periods")}
          className="m-0 flex list-none flex-col gap-4 p-0"
        >
          {periods.data.map((p) => (
            <li
              key={p.id}
              className="flex flex-wrap items-center justify-between gap-8 border-t border-border-subtle py-6 text-text-13"
            >
              <span>
                <span className="font-medium">{t(`crew.scheduling.availability.${p.kind}`)}</span>
                {" · "}
                {t("crew.common.range", { start: at(p.startsAt), end: at(p.endsAt) })}
              </span>
              <CrewInlineForm
                action={removeAvailabilityAction}
                hidden={{ org: ctx.org.slug, id: p.id }}
                submitLabel={t("crew.scheduling.availability.remove")}
                label={t("crew.scheduling.availability.removeLabel", { start: at(p.startsAt) })}
                variant="ghost"
                layout="inline"
              />
            </li>
          ))}
        </ul>
      ) : null}
      <CrewInlineForm
        action={addAvailabilityAction}
        hidden={{ org: ctx.org.slug, timeZone: s.timeZone }}
        submitLabel={t("crew.scheduling.availability.add")}
        successMessage={t("crew.scheduling.availability.added")}
        label={t("crew.scheduling.availability.addLabel")}
        layout="inline"
        resetOnSuccess
      >
        <Select
          id="availability-kind"
          name="kind"
          label={t("crew.scheduling.availability.kind")}
          value="Available"
          options={(["Available", "Tentative", "Unavailable"] as const).map((k) => ({
            value: k,
            label: t(`crew.scheduling.availability.${k}`),
          }))}
        />
        <Input
          id="availability-starts"
          name="startsAt"
          type="datetime-local"
          label={t("crew.fields.startsAt", { zone: s.timeZone })}
          required
          width={220}
        />
        <Input
          id="availability-ends"
          name="endsAt"
          type="datetime-local"
          label={t("crew.fields.endsAt", { zone: s.timeZone })}
          required
          width={220}
        />
      </CrewInlineForm>
    </section>
  );
}

export const contributions: readonly SettingsContribution[] = [
  { node: "settings.scheduling", order: 10, Panel: ShiftTemplatesPanel },
  { node: "me.work-details", order: 40, Panel: MyAvailabilityPanel },
];
