import { useState, type ReactElement } from "react";
import { Button, Card, Sheet, StateChip, Text, TextField } from "@xos/ui-native";
import type { DoorGuest } from "@xos/data/workforce-site";
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

export interface DoorCheckInScreenLabels extends FrameLabels {
  readonly search: string;
  readonly empty: string;
  readonly clearSearch: string;
  readonly failed: string;
  readonly checkIn: string;
  readonly checkedIn: string;
  readonly approved: string;
  readonly door: string;
  readonly sheetTitle: (name: string) => string;
  readonly close: string;
  readonly confirm: string;
  readonly plusOnes: (admitted: number, allowed: number) => string;
  readonly more: string;
  readonly fewer: string;
  readonly admitted: (plusOnes: number, door: string | null, at: string) => string;
}

export interface DoorCheckInScreenProps {
  readonly status: ScreenStatus;
  readonly labels: DoorCheckInScreenLabels;
  /** The door list, searched by the app as the person types. */
  readonly guests: readonly DoorGuest[];
  readonly search: string;
  readonly onSearch: (value: string) => void;
  readonly onCheckIn: Action<[entryId: string, plusOnesAdmitted: number, door: string | null]>;
  readonly refreshing?: boolean;
  readonly onRefresh?: () => void;
  readonly onRetry?: () => void;
  readonly errorReference?: string;
}

/** Compass door check-in: search the guest list and admit a guest with their plus-ones. */
export function DoorCheckInScreen({
  status,
  labels,
  guests,
  search,
  onSearch,
  onCheckIn,
  refreshing,
  onRefresh,
  onRetry,
  errorReference,
}: DoorCheckInScreenProps): ReactElement {
  const [guest, setGuest] = useState<DoorGuest | null>(null);
  const [plus, setPlus] = useState(0);
  const [door, setDoor] = useState("");
  const { busy, run, alert } = useActionRunner(labels.failed);
  const admit = async () => {
    if (guest === null) return;
    const ok = await run("admit", () =>
      onCheckIn(guest.entryId, plus, door.trim() === "" ? null : door.trim()),
    );
    if (ok) setGuest(null);
  };
  return (
    <WorkforceFrame
      status={status}
      labels={labels}
      testID="workforce-door"
      {...defined({ refreshing, onRefresh, onRetry, errorReference })}
    >
      <TextField label={labels.search} value={search} onChangeText={onSearch} />
      <TextField label={labels.door} value={door} onChangeText={setDoor} />
      {guests.length === 0 ? (
        <Empty
          sentence={labels.empty}
          actionLabel={labels.clearSearch}
          onAction={() => onSearch("")}
        />
      ) : (
        guests.map((g) => (
          <Card key={g.entryId} title={g.name} {...defined({ meta: g.note ?? undefined })}>
            <Stack>
              {g.state === "Checked In" ? (
                <>
                  <StateChip state="complete" label={labels.checkedIn} />
                  <Text variant="text13" tone="secondary">
                    {labels.admitted(g.plusOnesAdmitted ?? 0, g.door, g.checkedInAt ?? "")}
                  </Text>
                </>
              ) : (
                <>
                  <StateChip state="ready" label={labels.approved} />
                  <Button
                    label={labels.checkIn}
                    variant="primary"
                    icon="ticket"
                    block
                    onPress={() => {
                      setPlus(g.plusOnes);
                      setGuest(g);
                    }}
                  />
                </>
              )}
            </Stack>
          </Card>
        ))
      )}
      <Sheet
        open={guest !== null}
        title={labels.sheetTitle(guest?.name ?? "")}
        closeLabel={labels.close}
        onClose={() => setGuest(null)}
        footer={
          <Button
            label={labels.confirm}
            variant="primary"
            block
            loading={busy === "admit"}
            onPress={() => void admit()}
          />
        }
      >
        <Stack>
          {alert}
          <Text variant="heading20">{labels.plusOnes(plus, guest?.plusOnes ?? 0)}</Text>
          <Stack row>
            <Button
              label={labels.fewer}
              icon="minus"
              disabled={plus <= 0}
              onPress={() => setPlus((p) => Math.max(0, p - 1))}
            />
            <Button
              label={labels.more}
              icon="plus"
              disabled={plus >= (guest?.plusOnes ?? 0)}
              onPress={() => setPlus((p) => p + 1)}
            />
          </Stack>
        </Stack>
      </Sheet>
    </WorkforceFrame>
  );
}
