import {
  getWeatherBoard,
  HAZARD_UNITS,
  WEATHER_HAZARDS,
  WEATHER_LEVELS,
  type WeatherAlert,
} from "@xos/data/workforce-site";
import { listWorkforceRoles } from "@xos/data/people";
import { getFormatter } from "next-intl/server";
import {
  ActionButton,
  EmptyRefresh,
  EntityForm,
  ErrorPanel,
  KitSection,
} from "@/components/collection-kit/kit";
import { InlineAlert, PageHeader, StateChip } from "@/components/collection-kit/ui";
import { DataTable } from "@/components/platform/client/data-table";
import { EmptyStateLink } from "@/components/ui";
import {
  addAlertRoleAction,
  recordReadingAction,
  removeAlertRoleAction,
  setThresholdAction,
} from "@/lib/workforce/actions";
import type { SearchParams } from "@/lib/collection-kit/page";
import { nodeHref } from "@/lib/shell/sitemap";
import type { OrgContext } from "@/lib/shell/context";
import { ProjectPicker, REFUSALS, chosenProject, orgPickers, workforceCopy } from "./shared";

const LEVEL_STATE = { Monitor: "in-review", Restrict: "blocked", Evacuate: "blocked" } as const;

/**
 * Site Operations > Weather (Section 4.9 weather monitoring): wind, lightning and heat thresholds per
 * project at Monitor, Restrict and Evacuate, each with the emergency plan section it comes from, the
 * readings taken on site and the alerts they raised. Alerts go to the canon roles the plan names for
 * each level and to the project's dispatchers.
 */
export async function WeatherSection({
  ctx,
  path,
  search,
}: {
  ctx: OrgContext;
  path: string;
  search: SearchParams;
}) {
  const [t, format, pickers] = await Promise.all([
    workforceCopy(),
    getFormatter(),
    orgPickers(ctx),
  ]);
  const title = t("weather.title");
  const project = chosenProject(pickers.projects, search);
  if (project === null) {
    return (
      <>
        <PageHeader title={title} />
        <EmptyStateLink
          icon="FolderPlus"
          sentence={t("site.noProjects")}
          actionLabel={t("site.openProjects")}
          href={nodeHref("projects.all", { org: ctx.org.slug }) ?? "/"}
        />
      </>
    );
  }
  const db = ctx.viewer.db;
  const [board, roles] = await Promise.all([
    getWeatherBoard(db, project.id),
    listWorkforceRoles(db),
  ]);
  const picker = <ProjectPicker t={t} path={path} projects={pickers.projects} current={project} />;
  if (!board.ok) {
    return (
      <>
        <PageHeader title={title} />
        {picker}
        <ErrorPanel what={t("weather.what")} />
      </>
    );
  }
  const canConfigure = ctx.capabilities.has("safety.emergency_code.write");
  const canRecord = ctx.role !== "viewer";
  const when = (d: string) =>
    format.dateTime(new Date(d), { dateStyle: "medium", timeStyle: "short" });
  const active = board.data.alerts.filter((a) => a.clearedAt === null);
  const roleName = (code: string) => {
    const r = roles.ok ? roles.data.find((x) => x.code === code) : undefined;
    return r ? `${r.role} · ${code}` : code;
  };
  const alertLine = (a: WeatherAlert) =>
    t("weather.alertLine", {
      hazard: t(`weather.hazards.${a.hazard}`),
      level: t(`weather.levels.${a.level}`),
      time: when(a.issuedAt),
    });

  return (
    <div className="flex flex-col gap-16">
      <PageHeader title={title} />
      {picker}
      {active.length > 0 ? (
        <InlineAlert tone="danger" title={t("weather.activeTitle", { count: active.length })}>
          {active.map(alertLine).join(" · ")}
        </InlineAlert>
      ) : (
        <p role="status" className="m-0 text-text-13 text-text-secondary">
          {t("weather.allClear")}
        </p>
      )}
      {canRecord ? (
        <KitSection id="weather-reading" title={t("weather.record")}>
          <EntityForm
            id="weather-reading-form"
            action={recordReadingAction}
            hidden={{ org: ctx.org.slug, projectId: project.id }}
            refusals={REFUSALS}
            submitLabel={t("weather.recordSubmit")}
            fields={[
              {
                kind: "select",
                name: "hazard",
                label: t("weather.hazard"),
                required: true,
                defaultValue: "Wind",
                options: WEATHER_HAZARDS.map((h) => ({
                  value: h,
                  label: t("weather.hazardUnit", {
                    hazard: t(`weather.hazards.${h}`),
                    unit: t(`weather.units.${HAZARD_UNITS[h].unit}`),
                  }),
                })),
              },
              {
                kind: "number",
                name: "value",
                label: t("weather.value"),
                required: true,
                help: t("weather.valueHelp"),
              },
            ]}
          />
        </KitSection>
      ) : null}
      <KitSection id="weather-thresholds" title={t("weather.thresholds")}>
        {board.data.thresholds.length === 0 ? (
          canConfigure ? (
            <p className="m-0 text-text-13">{t("weather.noThresholds")}</p>
          ) : (
            <EmptyRefresh icon="CloudLightning" sentence={t("weather.noThresholdsRead")} />
          )
        ) : (
          <DataTable
            caption={t("weather.thresholds")}
            label={t("weather.thresholds")}
            columns={[
              { key: "hazard", label: t("weather.hazard") },
              { key: "level", label: t("weather.level") },
              { key: "value", label: t("weather.trigger") },
              { key: "source", label: t("weather.source"), wrap: true },
            ]}
            rows={board.data.thresholds.map((x) => ({
              id: x.id,
              hazard: t(`weather.hazards.${x.hazard}`),
              level: t(`weather.levels.${x.level}`),
              value: t(
                HAZARD_UNITS[x.hazard].comparison === "At or Below"
                  ? "weather.atOrBelow"
                  : "weather.atOrAbove",
                { value: x.value, unit: t(`weather.units.${x.unit}`) },
              ),
              source: x.sourceNote,
            }))}
          />
        )}
        <p className="m-0 text-text-12 text-text-secondary">{t("weather.canonNote")}</p>
        {canConfigure ? (
          <EntityForm
            id="weather-threshold-form"
            action={setThresholdAction}
            hidden={{ org: ctx.org.slug, projectId: project.id }}
            refusals={REFUSALS}
            submitLabel={t("weather.setThreshold")}
            fields={[
              {
                kind: "select",
                name: "hazard",
                label: t("weather.hazard"),
                required: true,
                defaultValue: "Wind",
                options: WEATHER_HAZARDS.map((h) => ({
                  value: h,
                  label: t(`weather.hazards.${h}`),
                })),
              },
              {
                kind: "select",
                name: "level",
                label: t("weather.level"),
                required: true,
                defaultValue: "Monitor",
                options: WEATHER_LEVELS.map((l) => ({ value: l, label: t(`weather.levels.${l}`) })),
              },
              {
                kind: "number",
                name: "value",
                label: t("weather.thresholdValue"),
                required: true,
                help: t("weather.thresholdHelp"),
              },
              {
                kind: "text",
                name: "sourceNote",
                label: t("weather.source"),
                required: true,
                help: t("weather.sourceHelp"),
              },
            ]}
          />
        ) : null}
      </KitSection>
      <KitSection id="weather-roles" title={t("weather.roles")}>
        {board.data.roles.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("weather.noRoles")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-8 p-0 text-text-13">
            {board.data.roles.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-8">
                <span>
                  {t("weather.roleLine", {
                    level: t(`weather.levels.${r.level}`),
                    role: roleName(r.roleCode),
                  })}
                </span>
                {canConfigure ? (
                  <ActionButton
                    action={removeAlertRoleAction}
                    hidden={{ org: ctx.org.slug, id: r.id }}
                    label={t("weather.removeRole")}
                    refusals={REFUSALS}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canConfigure ? (
          <EntityForm
            id="weather-role-form"
            action={addAlertRoleAction}
            hidden={{ org: ctx.org.slug, projectId: project.id }}
            refusals={REFUSALS}
            submitLabel={t("weather.addRole")}
            fields={[
              {
                kind: "select",
                name: "level",
                label: t("weather.level"),
                required: true,
                defaultValue: "Evacuate",
                options: WEATHER_LEVELS.map((l) => ({ value: l, label: t(`weather.levels.${l}`) })),
              },
              {
                kind: "select",
                name: "roleCode",
                label: t("weather.role"),
                required: true,
                blankLabel: t("feed.pickOne"),
                options: (roles.ok ? roles.data : []).map((r) => ({
                  value: r.code,
                  label: `${r.role} · ${r.code}`,
                })),
              },
            ]}
          />
        ) : null}
      </KitSection>
      <KitSection id="weather-history" title={t("weather.history")}>
        {board.data.readings.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("weather.noReadings")}</p>
        ) : (
          <DataTable
            caption={t("weather.history")}
            label={t("weather.history")}
            columns={[
              { key: "time", label: t("weather.time") },
              { key: "hazard", label: t("weather.hazard") },
              { key: "value", label: t("weather.value") },
              { key: "by", label: t("weather.by") },
            ]}
            rows={board.data.readings.map((r) => ({
              id: r.id,
              time: when(r.observedAt),
              hazard: t(`weather.hazards.${r.hazard}`),
              value: `${r.value} ${t(`weather.units.${HAZARD_UNITS[r.hazard].unit}`)}`,
              by: r.recordedBy ?? t("someone"),
            }))}
          />
        )}
        {board.data.alerts.length > 0 ? (
          <ul
            className="m-0 flex list-none flex-col gap-4 p-0 text-text-13"
            aria-label={t("weather.alerts")}
          >
            {board.data.alerts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-8">
                <StateChip
                  state={a.clearedAt ? "complete" : LEVEL_STATE[a.level]}
                  label={a.clearedAt ? t("weather.cleared") : t(`weather.levels.${a.level}`)}
                  compact
                />
                <span>{alertLine(a)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </KitSection>
    </div>
  );
}
