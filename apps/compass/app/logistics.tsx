import type { Row } from "@xos/sync";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import {
  buildDockCheckIn,
  buildFulfillmentMove,
  buildGateArrival,
  buildRelease,
  buildYardEntry,
  dockBoard,
  fulfillmentMoves,
  openFulfillments,
  vehicleProblem,
  waitingVehicles,
  yardLog,
  type DockSlotRow,
  type FulfillmentRow,
  type GateQueueRow,
  type MarshallingRow,
} from "../src/domain/logistics";
import { useCompass, useRows } from "../src/runtime/CompassProvider";
import {
  DenialNotice,
  formatTime,
  ProjectPicker,
  SyncBanner,
  useAllowed,
} from "../src/screens/common";
import {
  Button,
  Card,
  EmptyState,
  InlineAlert,
  ListRow,
  Screen,
  Tag,
  Text,
  TextField,
  useTheme,
} from "../src/ui";

interface ZoneRow extends Row {
  readonly code: string;
  readonly name: string;
}

/**
 * More > Logistics (Section 4.3 item 8): dock slot check-in, the gate queue with release, the marshalling
 * yard log and fulfillment moves, each queued offline and replayed once through A11's field RPCs.
 */
export default function LogisticsScreen(): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  const { projectId, enqueue } = useCompass();
  const canDock = useAllowed("logistics.dock");
  const canYard = useAllowed("logistics.yard");
  const canRelease = useAllowed("logistics.release");
  const canFulfill = useAllowed("hospitality.fulfillment");
  const { rows: slots } = useRows<DockSlotRow & Row>("dock_slots");
  const { rows: gate } = useRows<GateQueueRow & Row>("gate_queue");
  const { rows: log } = useRows<MarshallingRow & Row>("marshalling_log");
  const { rows: fulfillments } = useRows<FulfillmentRow & Row>("fulfillments");
  const { rows: zones } = useRows<ZoneRow>("zones");
  const [vehicle, setVehicle] = useState("");
  const [vehicleError, setVehicleError] = useState<string | undefined>(undefined);
  const [entry, setEntry] = useState("");
  const [entryError, setEntryError] = useState<string | undefined>(undefined);
  const [queued, setQueued] = useState<string | null>(null);

  if (!canDock && !canYard && !canRelease && !canFulfill) {
    return (
      <Screen testID="logistics" title={t("compass.logistics.title")}>
        <DenialNotice reason="capability" />
      </Screen>
    );
  }
  if (!projectId) {
    return (
      <Screen testID="logistics" title={t("compass.logistics.title")}>
        <ProjectPicker />
        <EmptyState
          testID="logistics-no-project"
          icon="truck"
          sentence={t("compass.common.noProject")}
          actionLabel={t("compass.common.chooseProject")}
        />
      </Screen>
    );
  }

  const zoneName = new Map(zones.map((z) => [z.id, `${z.code} ${z.name}`]));
  const board = dockBoard(slots, projectId);
  const waiting = waitingVehicles(gate, projectId);
  const entries = yardLog(log, projectId).slice(0, 20);
  const movable = openFulfillments(fulfillments, projectId);
  const send = (input: Parameters<typeof enqueue>[0], doneKey: string) => {
    void enqueue(input);
    setQueued(t(doneKey));
  };
  const arrive = () => {
    const problem = vehicleProblem(vehicle);
    if (problem) {
      setVehicleError(t(`compass.logistics.vehicle.${problem}`));
      return;
    }
    setVehicleError(undefined);
    send(
      buildGateArrival({ projectId, vehicle, shipmentId: null }, Date.now()),
      "compass.logistics.gate.recorded",
    );
    setVehicle("");
  };
  const addEntry = () => {
    if (entry.trim().length === 0) {
      setEntryError(t("compass.logistics.yard.required"));
      return;
    }
    setEntryError(undefined);
    send(
      buildYardEntry({ projectId, entry, shipmentId: null, zoneId: null }, Date.now()),
      "compass.logistics.yard.added",
    );
    setEntry("");
  };

  return (
    <Screen testID="logistics" title={t("compass.logistics.title")}>
      <ProjectPicker />
      <SyncBanner />
      {queued ? <InlineAlert testID="logistics-queued" tone="success" message={queued} /> : null}

      <Text variant="heading16" heading>
        {t("compass.logistics.dock.title")}
      </Text>
      {board.length === 0 ? (
        <Text tone="secondary">{t("compass.logistics.dock.empty")}</Text>
      ) : (
        board.map((s) => (
          <ListRow
            key={s.id}
            testID={`dock-${s.id}`}
            icon="package"
            title={zoneName.get(s.zone_id) ?? t("compass.logistics.dock.zoneUnknown")}
            subtitle={t("compass.logistics.dock.window", {
              start: formatTime(s.starts_at),
              end: formatTime(s.ends_at),
            })}
            trailing={
              s.checked_in_at ? (
                <Tag
                  tone="success"
                  label={t("compass.logistics.dock.checkedIn", {
                    time: formatTime(s.checked_in_at),
                  })}
                />
              ) : canDock ? (
                <Button
                  testID={`dock-check-in-${s.id}`}
                  label={t("compass.logistics.dock.checkIn")}
                  onPress={() =>
                    send(buildDockCheckIn(s, Date.now()), "compass.logistics.dock.queued")
                  }
                />
              ) : undefined
            }
          />
        ))
      )}

      <Text variant="heading16" heading>
        {t("compass.logistics.gate.title")}
      </Text>
      {waiting.length === 0 ? (
        <Text tone="secondary">{t("compass.logistics.gate.empty")}</Text>
      ) : (
        waiting.map((v) => (
          <ListRow
            key={v.id}
            testID={`gate-${v.id}`}
            icon="truck"
            title={v.vehicle_identifier}
            subtitle={t("compass.logistics.gate.waiting", { time: formatTime(v.arrived_at) })}
            trailing={
              canRelease ? (
                <Button
                  testID={`gate-release-${v.id}`}
                  label={t("compass.logistics.gate.release")}
                  onPress={() =>
                    send(buildRelease(v, Date.now()), "compass.logistics.gate.released")
                  }
                />
              ) : undefined
            }
          />
        ))
      )}
      {canYard ? (
        <Card title={t("compass.logistics.gate.arrive")}>
          <View style={{ gap: theme.space["8"] }}>
            <TextField
              testID="gate-vehicle"
              label={t("compass.logistics.vehicle.label")}
              help={t("compass.logistics.vehicle.help")}
              value={vehicle}
              onChangeText={setVehicle}
              autoComplete="off"
              {...(vehicleError ? { error: vehicleError } : {})}
            />
            <Button
              testID="gate-arrive"
              label={t("compass.logistics.gate.arrive")}
              onPress={arrive}
            />
          </View>
        </Card>
      ) : null}

      <Text variant="heading16" heading>
        {t("compass.logistics.yard.title")}
      </Text>
      {canYard ? (
        <Card title={t("compass.logistics.yard.add")}>
          <View style={{ gap: theme.space["8"] }}>
            <TextField
              testID="yard-entry"
              label={t("compass.logistics.yard.entry")}
              value={entry}
              onChangeText={setEntry}
              multiline
              {...(entryError ? { error: entryError } : {})}
            />
            <Button testID="yard-add" label={t("compass.logistics.yard.add")} onPress={addEntry} />
          </View>
        </Card>
      ) : null}
      {entries.length === 0 ? (
        <Text tone="secondary">{t("compass.logistics.yard.empty")}</Text>
      ) : (
        entries.map((e) => (
          <ListRow
            key={e.id}
            title={e.entry}
            subtitle={[formatTime(e.logged_at), e.zone_id ? zoneName.get(e.zone_id) : null]
              .filter(Boolean)
              .join(" · ")}
          />
        ))
      )}

      {canFulfill ? (
        <>
          <Text variant="heading16" heading>
            {t("compass.logistics.fulfillments.title")}
          </Text>
          {movable.length === 0 ? (
            <Text tone="secondary">{t("compass.logistics.fulfillments.empty")}</Text>
          ) : (
            movable.map((f) => (
              <Card
                key={f.id}
                testID={`fulfillment-${f.id}`}
                title={f.title}
                meta={
                  <Tag label={t(`compass.logistics.fulfillments.states.${f.fulfillment_state}`)} />
                }
                footer={
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space["8"] }}>
                    {fulfillmentMoves(f.fulfillment_state).map((next) => (
                      <Button
                        key={next}
                        testID={`fulfillment-${f.id}-${next}`}
                        variant={next === "Canceled" ? "ghost" : "secondary"}
                        label={t(`compass.logistics.fulfillments.moves.${next}`)}
                        onPress={() =>
                          send(
                            buildFulfillmentMove(
                              f,
                              next,
                              t("compass.logistics.fulfillments.reason"),
                            ),
                            "compass.logistics.fulfillments.queued",
                          )
                        }
                      />
                    ))}
                  </View>
                }
              >
                <Text tone="secondary">
                  {[
                    t(`compass.logistics.fulfillments.kinds.${f.fulfillment_kind}`),
                    f.starts_at ? formatTime(f.starts_at) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
              </Card>
            ))
          )}
        </>
      ) : null}
    </Screen>
  );
}
