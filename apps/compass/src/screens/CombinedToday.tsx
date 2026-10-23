/**
 * The combined Today (Section 4.5.7 org switching): for a person in several orgs, every org's shifts, day
 * sheets and next cue for today, grouped by org with its brand chip, the active org first. Each item is
 * placed on its own calendar (src/domain/orgs.ts), never the UTC date.
 */
import type { Row } from "@xos/sync";
import { useRouter } from "expo-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { combinedToday, type TodayCue, type TodaySheet } from "../domain/orgs";
import { scheduleZone } from "../domain/settings";
import type { ShiftRow } from "../domain/shifts";
import { formatCountdown, showsCountdown } from "../domain/show";
import { useCompass, useRows } from "../runtime/CompassProvider";
import { Card, ShiftCard, Text, useTheme } from "../ui";
import { BrandChip } from "./OrgSwitcher";
import { formatDay, formatTime, useRoleTitle } from "./common";

type LocalShift = ShiftRow & Row;

function NextCueCard({
  label,
  plannedAt,
  zone,
  nowMs,
}: {
  readonly label: string;
  readonly plannedAt: string;
  readonly zone: string;
  readonly nowMs: number;
}): ReactElement {
  const { t } = useTranslation();
  const ms = Date.parse(plannedAt) - nowMs;
  return (
    <Card title={t("compass.today.nextCue")}>
      <Text variant="heading20">{label}</Text>
      {showsCountdown(ms) ? (
        <Text tone="accent">{formatCountdown(ms)}</Text>
      ) : (
        <Text tone="secondary">
          {t("compass.today.nextCueAt", {
            day: formatDay(plannedAt, zone),
            time: formatTime(plannedAt, zone),
          })}
        </Text>
      )}
    </Card>
  );
}

export function CombinedToday({
  clockState,
}: {
  /** The clock state of the active org's shift, so the worked shift reads On Shift. */
  readonly clockState: "out" | "on" | "break";
}): ReactElement | null {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const roleTitle = useRoleTitle();
  const { resolved, personZone, setOrgId, orgSettings } = useCompass();
  const all = { allOrgs: true } as const;
  const { rows: shifts } = useRows<LocalShift>("shifts", undefined, all);
  const { rows: sheets } = useRows<TodaySheet & Row>("day_sheets", undefined, all);
  const { rows: cues } = useRows<TodayCue & Row>("cues", undefined, all);
  const { rows: projects } = useRows<Row & { time_zone?: string | null }>(
    "projects",
    undefined,
    all,
  );
  if (!resolved || resolved.contexts.length < 2) return null;
  const now = Date.now();
  const groups = combinedToday({
    orgs: resolved.contexts.map((c) => ({
      orgId: c.orgId,
      orgName: c.orgName,
      projectIds: c.projects.map((p) => p.id),
      me: {
        membershipId: c.identity.membershipId,
        engagementIds: c.identity.engagements
          .filter((e) => e.state === "Active" || e.state === "Closing")
          .map((e) => e.id),
      },
    })),
    activeOrgId: resolved.orgId,
    shifts,
    sheets,
    cues,
    projects,
    personZone,
    nowMs: now,
  });
  // Times read in the item's zone, or the person's own when they asked for that (me.time_zone_display, A97);
  // which day an item is on always follows its own calendar (combinedToday).
  const zoneOf = (projectId: string, own?: string | null) => {
    const zone = own ?? projects.find((p) => p.id === projectId)?.time_zone ?? personZone;
    return scheduleZone(zone, orgSettings) ?? zone;
  };
  return (
    <View testID="combined-today" style={{ gap: theme.space["16"] }}>
      <Text variant="heading20" heading>
        {t("compass.orgs.combinedTitle")}
      </Text>
      {groups.map((g) => (
        <View key={g.orgId} testID={`today-org-${g.orgId}`} style={{ gap: theme.space["8"] }}>
          <BrandChip testID={`today-org-chip-${g.orgId}`} orgId={g.orgId} name={g.orgName} />
          {g.empty ? <Text tone="secondary">{t("compass.orgs.nothingToday")}</Text> : null}
          {g.shifts.map((s) => {
            const zone = zoneOf(s.project_id, s.time_zone);
            const working = g.active && clockState !== "out" && s.id === g.working?.id;
            return (
              <ShiftCard
                key={s.id}
                testID={`today-org-shift-${s.id}`}
                state={working || s.shift_state === "Accepted" ? "active" : "scheduled"}
                stateLabel={t(
                  working
                    ? clockState === "break"
                      ? "compass.clock.onBreak"
                      : "compass.clock.onShift"
                    : s.shift_state === "Accepted"
                      ? "compass.schedule.accepted"
                      : "compass.schedule.published",
                )}
                role={roleTitle(s)}
                date={formatDay(s.starts_at, zone)}
                time={t("compass.schedule.timeRange", {
                  start: formatTime(s.starts_at, zone),
                  end: formatTime(s.ends_at, zone),
                })}
                place={t("compass.schedule.noPlace")}
                onPress={() => {
                  // Opening another org's shift makes that org active, so Schedule shows it.
                  if (!g.active) setOrgId(g.orgId);
                  router.push("/schedule");
                }}
              />
            );
          })}
          {g.sheets.map((d) => (
            <Card key={d.id} title={t("nav.compass.content.daySheet")}>
              <Text>{d.body}</Text>
            </Card>
          ))}
          {g.nextCue?.planned_at ? (
            <NextCueCard
              label={g.nextCue.label}
              plannedAt={g.nextCue.planned_at}
              zone={zoneOf(g.nextCue.project_id ?? "")}
              nowMs={now}
            />
          ) : null}
        </View>
      ))}
    </View>
  );
}
