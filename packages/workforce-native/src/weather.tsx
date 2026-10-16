import { useState, type ReactElement } from "react";
import { Banner, Button, ListRow, SegmentedControl, Tag, TextField } from "@xos/ui-native";
import {
  HAZARD_UNITS,
  WEATHER_HAZARDS,
  type WeatherAlertLevel,
  type WeatherBoard,
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
}

export interface WeatherScreenProps {
  readonly status: ScreenStatus;
  readonly labels: WeatherScreenLabels;
  readonly board: WeatherBoard | null;
  readonly onRecord: Action<[hazard: WeatherHazard, value: number]>;
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
  refreshing,
  onRefresh,
  onRetry,
  errorReference,
}: WeatherScreenProps): ReactElement {
  const [hazard, setHazard] = useState<WeatherHazard>("Wind");
  const [value, setValue] = useState("");
  const { busy, run, alert } = useActionRunner(labels.failed);
  const active = (board?.alerts ?? []).filter((a) => a.clearedAt === null);
  const unit = HAZARD_UNITS[hazard].unit;
  const number = Number(value);
  const valid = value.trim() !== "" && Number.isFinite(number) && number >= 0;
  const save = async () => {
    if (await run("record", () => onRecord(hazard, number))) setValue("");
  };
  return (
    <WorkforceFrame
      status={status === "ready" && board === null ? "error" : status}
      labels={labels}
      testID="workforce-weather"
      {...defined({ refreshing, onRefresh, onRetry, errorReference })}
    >
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
    </WorkforceFrame>
  );
}
