import type { Row } from "@xos/sync";
import * as Linking from "expo-linking";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { moreMenu } from "../src/domain/access";
import { drivesByDay, nowMs } from "../src/domain/drives";
import { formatDay, formatTime } from "../src/domain/schedule-time";
import { useCompass, useRows } from "../src/runtime/CompassProvider";
import { DenialNotice } from "../src/screens/common";
import { Button, Card, EmptyState, ListRow, Screen, Skeleton, Text } from "../src/ui";

const D = "compass.drives";

/**
 * More > Drives (B5, G-33): the transfers the signed-in person drives, today and the days ahead, grouped by the day
 * of the pickup on the project's calendar, from the rows on the device, so it reads offline after a download. Each
 * shows the pickup and drop-off in their own zones, the vehicle and seats, the passengers (primary first), the flight
 * it meets and a status worked out from the clock, and the day's Transport contacts to call in one tap.
 */
export default function DrivesScreen(): ReactElement {
  const { t } = useTranslation();
  const { resolved, refresh } = useCompass();
  const [refreshing, setRefreshing] = useState(false);
  const { rows: transfers, loading } = useRows<Row>("my_transfers", undefined, { allOrgs: true });
  const { rows: contacts } = useRows<Row>("local_contacts", undefined, { allOrgs: true });
  const { rows: projects } = useRows<Row & { time_zone?: string | null }>("projects", undefined, {
    allOrgs: true,
  });
  const title = t("nav.compass.more.drives");
  if (!resolved || loading) {
    return (
      <Screen testID="drives" title={title}>
        <Skeleton lines={4} />
      </Screen>
    );
  }
  if (!moreMenu(resolved.identity.audience).some((m) => m.id === "drives")) {
    return (
      <Screen testID="drives" title={title}>
        <DenialNotice reason="role" />
      </Screen>
    );
  }
  const zoneOf = (projectId: string | null) =>
    projects.find((p) => p.id === projectId)?.time_zone ?? "UTC";
  const days = drivesByDay({ transfers, contacts, zoneOf, now: nowMs() });
  return (
    <Screen
      testID="drives"
      title={title}
      refreshing={refreshing}
      onRefresh={() => {
        setRefreshing(true);
        void refresh().finally(() => setRefreshing(false));
      }}
    >
      {days.length === 0 ? (
        <EmptyState
          testID="drives-empty"
          icon="truck"
          sentence={t(`${D}.empty`)}
          actionLabel={t("compass.common.refresh")}
        />
      ) : (
        days.map((day) => (
          <Card
            key={day.day}
            testID={`drives-day-${day.day}`}
            title={formatDay(`${day.day}T12:00:00Z`, "UTC")}
          >
            {day.drives.map((d) => (
              <ListRow
                key={d.id}
                testID={`drive-${d.id}`}
                icon="truck"
                title={t(`${D}.route`, { from: d.pickupPlace, to: d.dropoffPlace })}
                subtitle={[
                  t(`${D}.window`, {
                    pickup: formatTime(d.pickupAt, d.pickupTimeZone),
                    dropoff: formatTime(d.dropoffAt, d.dropoffTimeZone),
                  }),
                  d.vehicle ? t(`${D}.vehicle`, { label: d.vehicle, seats: d.seats ?? 0 }) : null,
                  d.passengers.length > 0
                    ? t(`${D}.passengers`, {
                        names: d.passengers
                          .map((n) =>
                            n === d.primaryPassenger ? t(`${D}.primary`, { name: n }) : n,
                          )
                          .join(", "),
                      })
                    : t(`${D}.noPassengers`),
                  d.meetsFlight
                    ? t(`${D}.meets`, {
                        flight: d.meetsFlight,
                        time: d.meetsArrivesAt
                          ? formatTime(d.meetsArrivesAt, d.pickupTimeZone)
                          : t(`${D}.landingUnknown`),
                      })
                    : null,
                  t(`${D}.status.${d.status.toLowerCase()}`),
                ]
                  .filter((v): v is string => typeof v === "string" && v !== "")
                  .join(" · ")}
              />
            ))}
            {day.callContacts.length === 0 ? (
              <Text tone="secondary">{t(`${D}.noTransportContact`)}</Text>
            ) : (
              day.callContacts.map((c) => (
                <Button
                  key={c.id}
                  testID={`drives-call-${c.id}`}
                  label={t(`${D}.call`, { name: c.name })}
                  variant="secondary"
                  onPress={() => void Linking.openURL(`tel:${c.tel}`)}
                />
              ))
            )}
          </Card>
        ))
      )}
    </Screen>
  );
}
