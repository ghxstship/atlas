import { useState, type ReactElement } from "react";
import { Banner, Button, ListRow, SegmentedControl, Sheet, Tag, TextField } from "@xos/ui-native";
import {
  HAZARD_UNITS,
  isSevereWarning,
  WEATHER_HAZARDS,
  type WeatherAlertLevel,
  type WeatherBoard,
  type WeatherFeedBoard,
  type WeatherHazard,
} from "@xos/data/workforce-site";
import {
  Empty,
  Section,
  Stack,
  WorkforceFrame,
  defined,
  useActionRunner,
  type Action,
  type FrameLabels,
  type ScreenStatus,
} from "./shared.tsx";

export interface WeatherScreenLabels extends FrameLabels {
  readonly failed: string;
  readonly alerts: string;
  readonly noAlerts: string;
  readonly readings: string;
  readonly noReadings: string;
  readonly thresholds: string;
  readonly noThresholds: string;
  readonly record: string;
  readonly hazard: string;
  readonly value: (unit: string) => string;
  readonly valueError: string;
  readonly save: string;
  readonly hazards: Readonly<Record<WeatherHazard, string>>;
  readonly levels: Readonly<Record<WeatherAlertLevel, string>>;
  readonly alertLine: (hazard: string, level: string, issuedAt: string) => string;
  readonly readingLine: (value: number, unit: string, observedAt: string) => string;
  /** A threshold: the level, value and unit with the plan section it came from. */
  readonly thresholdLine: (level: string, value: number, unit: string, source: string) => string;
  // B8 (2976, 2977): the open hold, official warnings, and the dispatcher's hold and all-clear.
  readonly holdSince: (calledAt: string) => string;
  readonly warnings: string;
  readonly noWarnings: string;
  readonly issuedBy: string;
  readonly severities: Readonly<Record<string, string>>;
  readonly callHold: string;
  readonly allClear: string;
  readonly message: string;
  readonly messageHelp: string;
  readonly send: string;
  readonly close: string;
  readonly defaultHold: (hazard: string | null) => string;
  readonly defaultAllClear: string;
}

export interface WeatherScreenProps {
  readonly status: ScreenStatus;
  readonly labels: WeatherScreenLabels;
  readonly board: WeatherBoard | null;
  readonly onRecord: Action<[hazard: WeatherHazard, value: number]>;
  /** The official feed's warnings, the open hold and the templates, when the device could read them. */
  readonly feed?: WeatherFeedBoard | null;
  /** True for a dispatcher (safety.incident.dispatch on the project), who may call a hold and give the all-clear. */
  readonly canDispatch?: boolean;
  readonly onCallHold?: Action<[message: string, hazard: WeatherHazard | null]>;
  readonly onAllClear?: Action<[holdId: string, message: string]>;
  readonly refreshing?: boolean;
  readonly onRefresh?: () => void;
  readonly onRetry?: () => void;
  readonly errorReference?: string;
}

const LEVEL_TONE = { Monitor: "info", Restrict: "warning", Evacuate: "danger" } as const;

/** Compass Weather: active alerts, readings against the org's thresholds, and a reading form. */
export function WeatherScreen({
  status,
  labels,
  board,
  onRecord,
  feed,
  canDispatch,
  onCallHold,
  onAllClear,
  refreshing,
  onRefresh,
  onRetry,
  errorReference,
}: WeatherScreenProps): ReactElement {
  const [hazard, setHazard] = useState<WeatherHazard>("Wind");
  // The hold or all-clear sheet, prefilled from the project's text or the catalog's, and editable before it is sent.
  const [sheet, setSheet] = useState<{ kind: "hold" | "clear"; message: string } | null>(null);
  const [value, setValue] = useState("");
  const { busy, run, alert } = useActionRunner(labels.failed);
  const active = (board?.alerts ?? []).filter((a) => a.clearedAt === null);
  const unit = HAZARD_UNITS[hazard].unit;
  const number = Number(value);
  const valid = value.trim() !== "" && Number.isFinite(number) && number >= 0;
  const save = async () => {
    if (await run("record", () => onRecord(hazard, number))) setValue("");
  };
  const hold = feed?.openHold ?? null;
  const prompt = active.find((a) => a.level !== "Monitor") ?? active[0];
  const openHoldSheet = () =>
    setSheet({
      kind: "hold",
      message:
        feed?.templates.Hold?.body ??
        labels.defaultHold(prompt ? labels.hazards[prompt.hazard] : null),
    });
  const send = async () => {
    if (sheet === null) return;
    const message = sheet.message.trim();
    const ok =
      sheet.kind === "hold"
        ? onCallHold !== undefined &&
          (await run("hold", () => onCallHold(message, prompt?.hazard ?? null)))
        : hold !== null &&
          onAllClear !== undefined &&
          (await run("hold", () => onAllClear(hold.id, message)));
    if (ok) setSheet(null);
  };
  const severe =
    active.some((a) => a.level !== "Monitor") || (feed?.warnings ?? []).some(isSevereWarning);
  return (
    <WorkforceFrame
      status={status === "ready" && board === null ? "error" : status}
      labels={labels}
      testID="workforce-weather"
      {...defined({ refreshing, onRefresh, onRetry, errorReference })}
    >
      {hold ? (
        <Banner
          tone="danger"
          icon="octagon-alert"
          message={`${labels.holdSince(hold.calledAt)}: ${hold.message}`}
        />
      ) : null}
      {canDispatch && feed ? (
        hold ? (
          <Button
            testID="weather-all-clear"
            label={labels.allClear}
            variant="primary"
            icon="check"
            block
            onPress={() =>
              setSheet({
                kind: "clear",
                message: feed.templates["All Clear"]?.body ?? labels.defaultAllClear,
              })
            }
          />
        ) : (
          <Button
            testID="weather-call-hold"
            label={labels.callHold}
            variant={severe ? "primary" : "secondary"}
            icon="octagon-alert"
            block
            onPress={openHoldSheet}
          />
        )
      ) : null}
      {feed ? (
        <Section title={labels.warnings}>
          {feed.warnings.length === 0 ? (
            <Tag tone="success" label={labels.noWarnings} />
          ) : (
            feed.warnings.map((w) => (
              <ListRow
                key={w.id}
                title={w.event}
                subtitle={[labels.severities[w.severity] ?? w.severity, w.headline]
                  .filter(Boolean)
                  .join(" · ")}
                icon="triangle-alert"
              />
            ))
          )}
          <Tag tone="neutral" label={labels.issuedBy} />
        </Section>
      ) : null}
      <Section title={labels.alerts}>
        {active.length === 0 ? (
          <Tag tone="success" label={labels.noAlerts} />
        ) : (
          active.map((a) => (
            <Banner
              key={a.id}
              tone={LEVEL_TONE[a.level]}
              icon="triangle-alert"
              message={labels.alertLine(
                labels.hazards[a.hazard],
                labels.levels[a.level],
                a.issuedAt,
              )}
            />
          ))
        )}
      </Section>
      <Section title={labels.record}>
        <Stack>
          {alert}
          <SegmentedControl
            label={labels.hazard}
            value={hazard}
            options={WEATHER_HAZARDS.map((h) => ({ value: h, label: labels.hazards[h] }))}
            onChange={(v) => setHazard(v as WeatherHazard)}
          />
          <TextField
            label={labels.value(unit)}
            value={value}
            keyboard="numeric"
            onChangeText={setValue}
            {...defined({ error: value !== "" && !valid ? labels.valueError : undefined })}
          />
          <Button
            label={labels.save}
            variant="primary"
            icon="sun"
            disabled={!valid}
            loading={busy === "record"}
            onPress={() => void save()}
          />
        </Stack>
      </Section>
      <Section title={labels.readings}>
        {(board?.readings ?? []).length === 0 ? (
          <Empty sentence={labels.noReadings} actionLabel={labels.record} />
        ) : (
          (board?.readings ?? []).map((r) => (
            <ListRow
              key={r.id}
              title={labels.hazards[r.hazard]}
              subtitle={labels.readingLine(r.value, HAZARD_UNITS[r.hazard].unit, r.observedAt)}
              icon="gauge"
            />
          ))
        )}
      </Section>
      <Section title={labels.thresholds}>
        {(board?.thresholds ?? []).length === 0 ? (
          <Tag tone="warning" label={labels.noThresholds} />
        ) : (
          (board?.thresholds ?? []).map((t) => (
            <ListRow
              key={t.id}
              title={labels.hazards[t.hazard]}
              subtitle={labels.thresholdLine(labels.levels[t.level], t.value, t.unit, t.sourceNote)}
            />
          ))
        )}
      </Section>
      <Sheet
        open={sheet !== null}
        title={sheet?.kind === "clear" ? labels.allClear : labels.callHold}
        closeLabel={labels.close}
        onClose={() => setSheet(null)}
        footer={
          <Button
            label={labels.send}
            variant="primary"
            block
            disabled={(sheet?.message.trim() ?? "") === "" || (sheet?.message.length ?? 0) > 1000}
            loading={busy === "hold"}
            onPress={() => void send()}
          />
        }
      >
        <Stack>
          {alert}
          <TextField
            label={labels.message}
            help={labels.messageHelp}
            value={sheet?.message ?? ""}
            multiline
            onChangeText={(message) => setSheet((s) => (s ? { ...s, message } : s))}
          />
        </Stack>
      </Sheet>
    </WorkforceFrame>
  );
}
