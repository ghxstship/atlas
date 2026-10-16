import { useState, type ReactElement } from "react";
import {
  Banner,
  Button,
  Card,
  ProgressBar,
  SegmentedControl,
  Text,
  TextField,
} from "@xos/ui-native";
import { OCCUPANCY_LEVELS, type OccupancyCounter } from "@xos/data/workforce-site";
import {
  Empty,
  Stack,
  WorkforceFrame,
  defined,
  useActionRunner,
  type Action,
  type FrameLabels,
  type ScreenStatus,
} from "./shared.tsx";

export interface OccupancyCounterScreenLabels extends FrameLabels {
  readonly empty: string;
  readonly emptyAction: string;
  readonly failed: string;
  readonly counter: string;
  readonly door: string;
  readonly closed: string;
  readonly add: (n: number) => string;
  readonly remove: (n: number) => string;
  readonly count: (count: number, permitted: number) => string;
  readonly percent: (percent: number) => string;
  /** The alert banner at 80, 90 and 100 percent of the permitted load. */
  readonly level: (level: (typeof OCCUPANCY_LEVELS)[number]) => string;
}

export interface OccupancyCounterScreenProps {
  readonly status: ScreenStatus;
  readonly labels: OccupancyCounterScreenLabels;
  readonly counters: readonly OccupancyCounter[];
  /** Records a change of the count at a door; resolves after the server applied it. */
  readonly onCount: Action<[counterId: string, delta: number, door: string | null]>;
  readonly onEmptyAction?: () => void;
  readonly refreshing?: boolean;
  readonly onRefresh?: () => void;
  readonly onRetry?: () => void;
  readonly errorReference?: string;
}

/** The highest alert level a count has reached, or null under 80 percent. */
export function occupancyLevel(
  count: number,
  permitted: number,
): (typeof OCCUPANCY_LEVELS)[number] | null {
  if (permitted <= 0) return null;
  const percent = (100 * count) / permitted;
  return [...OCCUPANCY_LEVELS].reverse().find((l) => percent >= l) ?? null;
}

/** Compass occupancy counter: tap in and out at a door against the permitted load. */
export function OccupancyCounterScreen({
  status,
  labels,
  counters,
  onCount,
  onEmptyAction,
  refreshing,
  onRefresh,
  onRetry,
  errorReference,
}: OccupancyCounterScreenProps): ReactElement {
  const live = counters.filter((c) => c.closedAt === null);
  const [picked, setPicked] = useState<string | null>(null);
  const [door, setDoor] = useState("");
  const { busy, run, alert } = useActionRunner(labels.failed);
  const counter = live.find((c) => c.id === picked) ?? live[0] ?? null;
  const level = counter === null ? null : occupancyLevel(counter.count, counter.permittedLoad);
  const percent =
    counter === null || counter.permittedLoad <= 0
      ? 0
      : Math.round((100 * counter.count) / counter.permittedLoad);
  const count = (delta: number) => {
    if (counter === null) return;
    void run("count", () => onCount(counter.id, delta, door.trim() === "" ? null : door.trim()));
  };
  return (
    <WorkforceFrame
      status={status}
      labels={labels}
      testID="workforce-occupancy"
      {...defined({ refreshing, onRefresh, onRetry, errorReference })}
    >
      {counter === null ? (
        <Empty sentence={labels.empty} actionLabel={labels.emptyAction} onAction={onEmptyAction} />
      ) : (
        <Stack>
          {live.length > 1 ? (
            <SegmentedControl
              label={labels.counter}
              value={counter.id}
              options={live.map((c) => ({ value: c.id, label: c.name }))}
              onChange={setPicked}
            />
          ) : null}
          {level !== null ? (
            <Banner
              tone={level >= 100 ? "danger" : "warning"}
              icon="triangle-alert"
              message={labels.level(level)}
            />
          ) : null}
          {alert}
          <Card title={counter.name}>
            <Stack>
              <Text variant="heading32">{labels.count(counter.count, counter.permittedLoad)}</Text>
              <ProgressBar label={labels.percent(percent)} value={Math.min(percent, 100)} />
            </Stack>
          </Card>
          <TextField label={labels.door} value={door} onChangeText={setDoor} />
          <Stack row>
            <Button
              label={labels.add(1)}
              variant="primary"
              size="lg"
              icon="plus"
              disabled={busy !== null}
              onPress={() => count(1)}
            />
            <Button
              label={labels.add(5)}
              size="lg"
              disabled={busy !== null}
              onPress={() => count(5)}
            />
            <Button
              label={labels.remove(1)}
              size="lg"
              icon="minus"
              disabled={busy !== null || counter.count <= 0}
              onPress={() => count(-1)}
            />
          </Stack>
        </Stack>
      )}
      {counters.some((c) => c.closedAt !== null) ? (
        <Text variant="text13" tone="secondary">
          {labels.closed}
        </Text>
      ) : null}
    </WorkforceFrame>
  );
}
