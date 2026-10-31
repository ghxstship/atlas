/**
 * Today for a person who works the project only on a party's roster (R8, Section 4.5.7): their call, their
 * parking pass, the gear they hold and what waits at the desk, whom to ask, and a way to update their project
 * details. Every row is their own; Compass shows the status the database computes and never confirms possession,
 * which only an Issue does (owner decision 8). Project details are online only and never stored here (ADR 0071).
 */
import type { Row } from "@xos/sync";
import { todayIn } from "@xos/data/calendar";
import { useRouter, type Href } from "expo-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { operationalEngagements } from "../domain/access";
import { itemZone } from "../domain/orgs";
import {
  rosterToday,
  type AllocationRow,
  type CustodyRow,
  type ParkingPassRow,
  type RosterEntryRow,
  type ShiftRow,
} from "../domain/rosterToday";
import { useCompass, useRows } from "../runtime/CompassProvider";
import { Button, Card, EmptyState, ListRow, Text } from "../ui";
import { formatDay, formatTime } from "./common";

const R = "compass.today.roster";

export function RosterToday(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const { resolved, projectId, personZone } = useCompass();
  const engagements = resolved
    ? operationalEngagements(resolved.identity, projectId).filter((e) => e.via === "roster")
    : [];
  const entryIds = engagements.flatMap((e) => (e.rosterEntryId ? [e.rosterEntryId] : []));
  const { rows: entries } = useRows<RosterEntryRow & Row>("roster_entries", (r) =>
    entryIds.includes(String(r.id)),
  );
  const { rows: allocations } = useRows<AllocationRow & Row>("advance_allocations", (a) =>
    entryIds.includes(String(a.roster_entry_id)),
  );
  const { rows: passes } = useRows<ParkingPassRow & Row>(
    "parking_passes",
    (p) => p.project_id === projectId,
  );
  const { rows: custody } = useRows<CustodyRow & Row>("asset_custody", (c) =>
    entryIds.includes(String(c.roster_entry_id)),
  );
  // The shifts a staffing agency placed the person on (R12), from their roster entries' bucket.
  const { rows: shifts } = useRows<
    ShiftRow & Row & { roster_entry_id?: string | null; shift_state?: string }
  >("shifts", (s) => entryIds.includes(String(s.roster_entry_id)) && s.shift_state !== "Canceled");
  const { rows: projectRows } = useRows<Row & { time_zone?: string | null }>(
    "projects",
    (p) => p.id === projectId,
  );
  const zone = itemZone(null, projectRows[0]?.time_zone, personZone);
  const day = rosterToday({
    entries,
    allocations,
    passes,
    custody,
    shifts,
    projectTimeZone: zone,
    today: todayIn(zone),
  });
  const lead = engagements.find((e) => e.leadName)?.leadName ?? engagements[0]?.orgName ?? "";
  return (
    <>
      <Card testID="roster-call" title={t(`${R}.callTitle`)}>
        {day.call ? (
          <>
            <Text variant="heading20" heading>
              {formatTime(day.call.at, day.call.timeZone)}
            </Text>
            <Text tone="secondary">
              {day.arrival
                ? t(`${R}.arrival`, {
                    day: formatDay(day.arrival.startsAt, zone),
                    start: formatTime(day.arrival.startsAt, zone),
                    end: formatTime(day.arrival.endsAt, zone),
                  })
                : t(`${R}.fromShift`)}
            </Text>
          </>
        ) : (
          <Text tone="secondary">{t(`${R}.noArrival`)}</Text>
        )}
      </Card>
      <Card testID="roster-parking" title={t(`${R}.parkingTitle`)}>
        {day.parking.length === 0 ? (
          <Text tone="secondary">{t(`${R}.noParking`)}</Text>
        ) : (
          day.parking.map((p) => (
            <ListRow
              key={p.id}
              testID={`roster-parking-${p.id}`}
              icon="map-pin"
              title={p.category}
              subtitle={[p.zones.join(", "), p.vehicle].filter((v) => v !== "").join(" · ")}
              trailing={
                <Button
                  testID={`roster-show-pass-${p.id}`}
                  label={t(`${R}.showPass`)}
                  variant="secondary"
                  onPress={() => router.navigate("/scan")}
                />
              }
            />
          ))
        )}
      </Card>
      <Card testID="roster-gear" title={t(`${R}.gearTitle`)}>
        {day.gear.length === 0 && day.pickups.length === 0 ? (
          <EmptyState
            testID="roster-gear-empty"
            icon="package"
            sentence={t(`${R}.noGear`)}
            actionLabel={t("compass.common.refresh")}
          />
        ) : (
          <>
            {day.gear.map((g) => (
              <ListRow
                key={g.id}
                testID={`roster-gear-${g.id}`}
                icon="package"
                title={g.label}
                subtitle={t(`${R}.holding`)}
              />
            ))}
            {day.pickups.map((p) => (
              <ListRow
                key={p.id}
                testID={`roster-pickup-${p.id}`}
                icon="clipboard-list"
                title={p.label}
                subtitle={t(`${R}.pickup`, { status: t(`${R}.status.${statusKey(p.status)}`) })}
              />
            ))}
          </>
        )}
      </Card>
      <Card testID="roster-contact" title={t(`${R}.contactTitle`)}>
        <ListRow icon="user-round" title={lead} subtitle={t(`${R}.contactSentence`)} />
      </Card>
      <Button
        testID="roster-project-details"
        label={t(`${R}.projectDetails`)}
        variant="secondary"
        onPress={() => router.push("/project-details" as Href)}
      />
    </>
  );
}

/** The catalog key of a computed status: `On Order` becomes `onOrder`. */
function statusKey(status: string): string {
  return status
    .split(/\s+/)
    .map((w, i) =>
      i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
    )
    .join("");
}
