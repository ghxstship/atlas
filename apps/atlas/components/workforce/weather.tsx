import {
  getWeatherBoard,
  getWeatherFeedBoard,
  HAZARD_UNITS,
  isSevereWarning,
  WEATHER_HAZARDS,
  WEATHER_LEVELS,
  type WeatherAlert,
  type WeatherFeedBoard,
} from "@xos/data/workforce-site";
import { listWorkforceRoles } from "@xos/data/people";
import { getFormatter, getLocale } from "next-intl/server";
import { getShellSettings } from "@/lib/shell/org-settings";
import {
  formatHazardValue,
  hazardUnitSymbol,
  projectJurisdictionUnits,
  unitSystemFor,
} from "@/lib/workforce/units";
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
  callWeatherHoldAction,
  giveWeatherAllClearAction,
  recordReadingAction,
  removeAlertRoleAction,
  saveWeatherTemplatesAction,
  setThresholdAction,
  turnOffWeatherFeedAction,
  turnOnWeatherFeedAction,
} from "@/lib/workforce/actions";
import type { SearchParams } from "@/lib/collection-kit/page";
import { nodeHref } from "@/lib/shell/sitemap";
import type { OrgContext } from "@/lib/shell/context";
import { ProjectPicker, REFUSALS, chosenProject, orgPickers, workforceCopy } from "./shared";
import { CollectionPage } from "@/components/platform/collection-page";

const LEVEL_STATE = { Monitor: "in-review", Restrict: "blocked", Evacuate: "blocked" } as const;

/**
 * Site Operations > Weather (Section 4.9 weather monitoring): wind, lightning and heat thresholds per
 * project at Monitor, Restrict and Evacuate, each with the emergency plan section it comes from, the
 * readings taken on site and the alerts they raised. Alerts go to the canon roles the plan names for
 * each level and to the project's dispatchers. B8 (2976, 2977): the official US National Weather Service feed for a
 * US venue with a location (its status, active warnings and the next 12 hours, its readings marked by source), and
 * the hold and all-clear a dispatcher sends to everyone at once.
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
      <CollectionPage header={<PageHeader title={title} />}>
        <EmptyStateLink
          icon="FolderPlus"
          sentence={t("site.noProjects")}
          actionLabel={t("site.openProjects")}
          href={nodeHref("projects.all", { org: ctx.org.slug }) ?? "/"}
        />
      </CollectionPage>
    );
  }
  const db = ctx.viewer.db;
  const [board, roles, settings, jurisdiction, locale, feedBoard] = await Promise.all([
    getWeatherBoard(db, project.id),
    listWorkforceRoles(db),
    getShellSettings(db, ctx.org.id, null),
    projectJurisdictionUnits(db, project.id),
    getLocale(),
    getWeatherFeedBoard(db, project.id),
  ]);
  // Values show and are typed in the person's units (locale.units, Section 15), stored in the hazard's unit.
  const units = unitSystemFor(settings.preferences.units, jurisdiction, locale);
  const symbol = (h: (typeof WEATHER_HAZARDS)[number]) => hazardUnitSymbol(locale, h, units);
  const picker = <ProjectPicker t={t} path={path} projects={pickers.projects} current={project} />;
  if (!board.ok) {
    return (
      <CollectionPage header={<PageHeader title={title} />}>
        {picker}
        <ErrorPanel what={t("weather.what")} />
      </CollectionPage>
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

  const feed: WeatherFeedBoard | null = feedBoard.ok ? feedBoard.data : null;
  const canDispatch = ctx.capabilities.has("safety.incident.dispatch");
  // Call hold leads while an alert is at Restrict or Evacuate or an official Severe or Extreme warning is active.
  const severe =
    active.some((a) => a.level === "Restrict" || a.level === "Evacuate") ||
    (feed?.warnings ?? []).some(isSevereWarning);
  const promptAlert = active.find((a) => a.level !== "Monitor") ?? active[0];
  const promptWarning = (feed?.warnings ?? []).find(isSevereWarning);
  const holdText =
    feed?.templates.Hold?.body ??
    (promptAlert
      ? t("weather.templates.defaultHoldHazard", {
          hazard: t(`weather.hazards.${promptAlert.hazard}`),
        })
      : t("weather.templates.defaultHold"));
  const allClearText = feed?.templates["All Clear"]?.body ?? t("weather.templates.defaultAllClear");

  return (
    <CollectionPage header={<PageHeader title={title} />}>
      {picker}
      {feed?.openHold ? (
        <InlineAlert
          tone="danger"
          title={t("weather.holds.open", { time: when(feed.openHold.calledAt) })}
        >
          {feed.openHold.message}
        </InlineAlert>
      ) : null}
      {canDispatch && feed ? (
        <div className="flex flex-wrap gap-8">
          {feed.openHold ? (
            <ActionButton
              action={giveWeatherAllClearAction}
              hidden={{ org: ctx.org.slug, id: feed.openHold.id }}
              label={t("weather.holds.allClear")}
              variant="primary"
              confirm={{
                title: t("weather.holds.allClearTitle"),
                body: t("weather.holds.callBody"),
              }}
              extraFields={[
                {
                  kind: "textarea",
                  name: "message",
                  label: t("weather.holds.message"),
                  help: t("weather.holds.messageHelp"),
                  required: true,
                  defaultValue: allClearText,
                },
              ]}
              refusals={REFUSALS}
            />
          ) : (
            <ActionButton
              action={callWeatherHoldAction}
              hidden={{
                org: ctx.org.slug,
                projectId: project.id,
                ...(promptAlert
                  ? { hazard: promptAlert.hazard, weatherAlertId: promptAlert.id }
                  : {}),
                ...(promptWarning ? { weatherWarningId: promptWarning.id } : {}),
              }}
              label={t("weather.holds.call")}
              variant={severe ? "primary" : "secondary"}
              confirm={{ title: t("weather.holds.callTitle"), body: t("weather.holds.callBody") }}
              extraFields={[
                {
                  kind: "textarea",
                  name: "message",
                  label: t("weather.holds.message"),
                  help: t("weather.holds.messageHelp"),
                  required: true,
                  defaultValue: holdText,
                },
              ]}
              refusals={REFUSALS}
            />
          )}
        </div>
      ) : null}
      {active.length > 0 ? (
        <InlineAlert tone="danger" title={t("weather.activeTitle", { count: active.length })}>
          {active.map(alertLine).join(" · ")}
        </InlineAlert>
      ) : (
        <p role="status" className="m-0 text-text-13 text-text-secondary">
          {t("weather.allClear")}
        </p>
      )}
      {feed ? (
        <KitSection id="weather-feed" title={t("weather.feed.title")}>
          <p className="m-0 text-text-13 text-text-secondary">{t("weather.feed.what")}</p>
          {!feed.status.supported ? (
            <p className="m-0 text-text-13">{t("weather.feed.unsupported")}</p>
          ) : (
            <>
              <p role="status" className="m-0 text-text-13">
                {feed.status.feedId === null
                  ? null
                  : feed.status.lastSuccessAt
                    ? t("weather.feed.lastUpdate", { time: when(feed.status.lastSuccessAt) })
                    : t("weather.feed.never")}
              </p>
              {feed.status.feedId !== null &&
              feed.status.lastFailureAt &&
              feed.status.failuresSinceSuccess > 0 ? (
                <InlineAlert tone="warning">
                  {t("weather.feed.lastFailure", {
                    time: when(feed.status.lastFailureAt),
                    error: feed.status.lastError ?? "",
                  })}{" "}
                  {t("weather.feed.failuresSince", { count: feed.status.failuresSinceSuccess })}
                </InlineAlert>
              ) : null}
              {canConfigure ? (
                feed.status.feedId === null ? (
                  <ActionButton
                    action={turnOnWeatherFeedAction}
                    hidden={{ org: ctx.org.slug, projectId: project.id }}
                    label={t("weather.feed.turnOn")}
                    refusals={REFUSALS}
                  />
                ) : (
                  <ActionButton
                    action={turnOffWeatherFeedAction}
                    hidden={{ org: ctx.org.slug, id: feed.status.feedId }}
                    label={t("weather.feed.turnOff")}
                    refusals={REFUSALS}
                  />
                )
              ) : null}
            </>
          )}
          <h3 className="m-0 text-text-13 font-semibold">{t("weather.warnings.title")}</h3>
          {feed.warnings.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">{t("weather.warnings.empty")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-8 p-0 text-text-13">
              {feed.warnings.map((w) => (
                <li key={w.id} className="flex flex-col gap-4" lang="en-US">
                  <span className="flex flex-wrap items-center gap-8">
                    <StateChip
                      state={isSevereWarning(w) ? "blocked" : "in-review"}
                      label={t(`weather.warnings.severities.${w.severity}`)}
                      compact
                    />
                    <span className="font-semibold">{w.event}</span>
                    {(w.endsAt ?? w.expiresAt) ? (
                      <span className="text-text-secondary">
                        {t("weather.warnings.until", {
                          time: when((w.endsAt ?? w.expiresAt) as string),
                        })}
                      </span>
                    ) : null}
                  </span>
                  {w.headline ? <span>{w.headline}</span> : null}
                  {w.description || w.instruction ? (
                    <details>
                      <summary className="cursor-pointer text-text-secondary">
                        {t("weather.warnings.more")}
                      </summary>
                      {w.description ? (
                        <p className="m-0 whitespace-pre-line">{w.description}</p>
                      ) : null}
                      {w.instruction ? (
                        <p className="m-0 whitespace-pre-line">{w.instruction}</p>
                      ) : null}
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <p className="m-0 text-text-12 text-text-secondary">{t("weather.warnings.issuedBy")}</p>
          <h3 className="m-0 text-text-13 font-semibold">{t("weather.forecast.title")}</h3>
          {feed.forecast.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">{t("weather.forecast.empty")}</p>
          ) : (
            <DataTable
              caption={t("weather.forecast.title")}
              label={t("weather.forecast.title")}
              columns={[
                { key: "time", label: t("weather.time") },
                { key: "temperature", label: t("weather.hazards.Heat") },
                { key: "wind", label: t("weather.hazards.Wind") },
                { key: "rain", label: t("weather.forecast.rain") },
                { key: "summary", label: t("weather.forecast.summary"), wrap: true },
              ]}
              rows={feed.forecast.map((p) => ({
                id: p.startsAt,
                time: format.dateTime(new Date(p.startsAt), { weekday: "short", hour: "numeric" }),
                temperature:
                  p.temperatureF === null
                    ? ""
                    : t("weather.forecast.temperature", { value: Math.round(p.temperatureF) }),
                wind:
                  p.windSpeedMph === null
                    ? ""
                    : t("weather.forecast.wind", { value: Math.round(p.windSpeedMph) }),
                rain:
                  p.precipitationPercent === null
                    ? ""
                    : t("weather.forecast.precipitation", { value: p.precipitationPercent }),
                summary: p.shortForecast ?? "",
              }))}
            />
          )}
        </KitSection>
      ) : null}
      {canRecord ? (
        <KitSection id="weather-reading" title={t("weather.record")}>
          <EntityForm
            id="weather-reading-form"
            action={recordReadingAction}
            hidden={{ org: ctx.org.slug, projectId: project.id, units }}
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
                    unit: symbol(h),
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
                { measure: formatHazardValue(locale, x.hazard, x.value, units) },
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
            hidden={{ org: ctx.org.slug, projectId: project.id, units }}
            refusals={REFUSALS}
            submitLabel={t("weather.setThreshold")}
            submitVariant="secondary"
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
                help: t("weather.thresholdHelp", {
                  wind: symbol("Wind"),
                  distance: symbol("Lightning"),
                  heat: symbol("Heat"),
                }),
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
      {canConfigure && feed ? (
        <KitSection id="weather-templates" title={t("weather.templates.title")}>
          <EntityForm
            id="weather-templates-form"
            action={saveWeatherTemplatesAction}
            hidden={{
              org: ctx.org.slug,
              projectId: project.id,
              ...(feed.templates.Hold ? { holdId: feed.templates.Hold.id } : {}),
              ...(feed.templates["All Clear"]
                ? { allClearId: feed.templates["All Clear"].id }
                : {}),
            }}
            refusals={REFUSALS}
            submitLabel={t("weather.templates.save")}
            submitVariant="secondary"
            fields={[
              {
                kind: "textarea",
                name: "hold",
                label: t("weather.templates.hold"),
                required: true,
                defaultValue: feed.templates.Hold?.body ?? t("weather.templates.defaultHold"),
              },
              {
                kind: "textarea",
                name: "allClear",
                label: t("weather.templates.allClear"),
                required: true,
                defaultValue: allClearText,
              },
            ]}
          />
        </KitSection>
      ) : null}
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
            submitVariant="secondary"
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
              { key: "source", label: t("weather.source") },
              { key: "by", label: t("weather.by") },
            ]}
            rows={board.data.readings.map((r) => ({
              id: r.id,
              time: when(r.observedAt),
              hazard: t(`weather.hazards.${r.hazard}`),
              value: formatHazardValue(locale, r.hazard, r.value, units),
              source: t(`weather.readingSource.${r.source}`),
              by: r.source === "NWS" ? "" : (r.recordedBy ?? t("someone")),
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
    </CollectionPage>
  );
}
