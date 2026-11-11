import type { Row } from "@xos/sync";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import {
  bookingStatus,
  bookingsOf,
  buildBookingArrival,
  findBookings,
  gateRowOf,
  windowsToday,
  type BookingRow,
  type BookingStatus,
  type DeliveryWindowRow,
  type GateRow,
} from "../src/domain/gate";
import { buildDockCheckIn, buildRelease, vehicleProblem } from "../src/domain/logistics";
import { useCompass, useRows } from "../src/runtime/CompassProvider";
import {
  DenialNotice,
  formatTime,
  ProjectPicker,
  SyncBanner,
  useAllowed,
  useRefusal,
} from "../src/screens/common";
import {
  Button,
  Card,
  EmptyState,
  InlineAlert,
  ListRow,
  Screen,
  Skeleton,
  Tag,
  Text,
  TextField,
} from "../src/ui";

const REFUSAL_FEATURES = ["logistics.dock", "logistics.yard", "logistics.release"] as const;

interface ZoneRow extends Row {
  readonly code: string;
  readonly name: string;
}

interface ProjectRow extends Row {
  readonly time_zone: string;
}

const STATUS_KEY: Record<BookingStatus, string> = {
  Expected: "expected",
  Waiting: "waiting",
  Released: "released",
  "Checked In": "checkedIn",
};

/**
 * More > Logistics > Gate (B11, G-115): at a phone's width, a gate's windows today with their counts, a find by reference
 * code or plate, and Arrived, Release and Check in, each queued offline and replayed once. Each action shows only behind
 * its own capability (logistics.yard, logistics.release, logistics.dock).
 */
export default function LogisticsGateScreen(): ReactElement {
  const { t } = useTranslation();
  const { projectId, enqueue } = useCompass();
  const canDock = useAllowed("logistics.dock");
  const canYard = useAllowed("logistics.yard");
  const canRelease = useAllowed("logistics.release");
  // External people get the role refusal, internal ones the missing capability (C-16).
  const refusal = useRefusal(REFUSAL_FEATURES);
  const { rows: windows } = useRows<DeliveryWindowRow & Row>("delivery_windows");
  const { rows: slots } = useRows<BookingRow & Row>("dock_slots");
  const { rows: gate } = useRows<GateRow & Row>("gate_queue");
  const { rows: zones } = useRows<ZoneRow>("zones");
  const { rows: projects } = useRows<ProjectRow>("projects");
  const [zoneId, setZoneId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [plates, setPlates] = useState<Readonly<Record<string, string>>>({});
  const [plateError, setPlateError] = useState<string | null>(null);
  const [queued, setQueued] = useState<string | null>(null);

  if (refusal === "loading") {
    return (
      <Screen testID="logistics-gate" title={t("compass.gateView.title")}>
        <Skeleton lines={3} />
      </Screen>
    );
  }
  if (refusal) {
    return (
      <Screen testID="logistics-gate" title={t("compass.gateView.title")}>
        <DenialNotice reason={refusal} />
      </Screen>
    );
  }
  if (!projectId) {
    return (
      <Screen testID="logistics-gate" title={t("compass.gateView.title")}>
        <ProjectPicker />
        <EmptyState
          testID="gate-no-project"
          icon="truck"
          sentence={t("compass.common.noProject")}
          actionLabel={t("compass.common.chooseProject")}
        />
      </Screen>
    );
  }

  const timeZone = projects.find((p) => p.id === projectId)?.time_zone ?? "UTC";
  const projectWindows = windows.filter((w) => w.project_id === projectId && !w.deleted_at);
  const gateIds = [...new Set(projectWindows.map((w) => w.zone_id))];
  const gates = zones.filter((z) => gateIds.includes(z.id));
  const zone = zoneId ?? gates[0]?.id ?? null;
  const today = zone
    ? windowsToday(windows, { projectId, zoneId: zone, timeZone, nowMs: Date.now() })
    : [];
  const found = findBookings(slots, { projectId, query });

  const send = (input: Parameters<typeof enqueue>[0], doneKey: string) => {
    void enqueue(input);
    setQueued(t(doneKey));
  };
  const arrive = (slot: BookingRow) => {
    const typed = plates[slot.id]?.trim() ?? "";
    const needsPlate = typed.length > 0 || !slot.vehicle_identifier;
    const problem = needsPlate ? vehicleProblem(typed) : null;
    if (problem) {
      setPlateError(t(`compass.logistics.vehicle.${problem}`));
      return;
    }
    setPlateError(null);
    send(buildBookingArrival(slot, typed || null, Date.now()), "compass.gateView.arrivalQueued");
  };

  const bookingCard = (slot: BookingRow) => {
    const row = gateRowOf(gate, slot.id);
    const status = bookingStatus(slot, row);
    return (
      <Card key={slot.id} testID={`gate-booking-${slot.id}`}>
        <Text variant="heading16" heading>
          {slot.reference_code ?? ""}
        </Text>
        <Text tone="secondary">{slot.vehicle_identifier ?? t("compass.gateView.noPlate")}</Text>
        <Tag
          testID={`gate-status-${slot.id}`}
          label={t(`compass.gateView.status.${STATUS_KEY[status]}`)}
        />
        {status === "Expected" && canYard ? (
          <>
            {slot.vehicle_identifier ? null : (
              <TextField
                testID={`gate-plate-${slot.id}`}
                label={t("compass.logistics.vehicle.label")}
                value={plates[slot.id] ?? ""}
                onChangeText={(v: string) => setPlates({ ...plates, [slot.id]: v })}
              />
            )}
            <Button
              testID={`gate-arrived-${slot.id}`}
              label={t("compass.gateView.arrived")}
              onPress={() => arrive(slot)}
            />
          </>
        ) : null}
        {status === "Waiting" && canRelease && row ? (
          <Button
            testID={`gate-release-${slot.id}`}
            label={t("compass.logistics.gate.release")}
            onPress={() => send(buildRelease(row, Date.now()), "compass.logistics.gate.released")}
          />
        ) : null}
        {(status === "Released" || status === "Waiting") && canDock ? (
          <Button
            testID={`gate-check-in-${slot.id}`}
            variant="secondary"
            label={t("compass.logistics.dock.checkIn")}
            onPress={() =>
              send(buildDockCheckIn(slot, Date.now()), "compass.logistics.dock.queued")
            }
          />
        ) : null}
      </Card>
    );
  };

  return (
    <Screen testID="logistics-gate" title={t("compass.gateView.title")}>
      <ProjectPicker />
      <SyncBanner />
      {queued ? <InlineAlert testID="gate-queued" tone="success" message={queued} /> : null}
      {plateError ? (
        <InlineAlert testID="gate-plate-error" tone="danger" message={plateError} />
      ) : null}
      <TextField
        testID="gate-find"
        label={t("compass.gateView.find")}
        help={t("compass.gateView.findHelp")}
        value={query}
        onChangeText={setQuery}
      />
      {query.trim() ? (
        found.length === 0 ? (
          <Text tone="secondary">{t("compass.gateView.notFound")}</Text>
        ) : (
          found.map(bookingCard)
        )
      ) : (
        <>
          <View>
            {gates.map((g) => (
              <ListRow
                key={g.id}
                testID={`gate-pick-${g.id}`}
                icon="map-pin"
                title={`${g.code} ${g.name}`}
                {...(g.id === zone ? { subtitle: t("compass.gateView.selected") } : {})}
                onPress={() => setZoneId(g.id)}
              />
            ))}
          </View>
          {today.length === 0 ? (
            <Text tone="secondary">{t("compass.gateView.empty")}</Text>
          ) : (
            today.map((w) => {
              const bookings = bookingsOf(slots, w.id);
              return (
                <View key={w.id}>
                  <Text variant="heading16" heading>
                    {t("compass.gateView.window", {
                      start: formatTime(w.starts_at, timeZone),
                      end: formatTime(w.ends_at, timeZone),
                      booked: bookings.length,
                      limit: w.vehicle_limit,
                    })}
                  </Text>
                  {bookings.map(bookingCard)}
                </View>
              );
            })
          )}
        </>
      )}
    </Screen>
  );
}
