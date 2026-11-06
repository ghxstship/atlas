import { useEffect, useRef, useState, type ReactElement } from "react";
import { Banner, Button, Card, Sheet, StateChip, Text, TextField } from "@xos/ui-native";
import { guestByPassCode, passCodeFromScan, type DoorGuest } from "@xos/data/workforce-site";
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
  // B8 (2974): a guest's pass, scanned or typed at the door.
  readonly pass: string;
  readonly passHelp: string;
  readonly checkPass: string;
  readonly passNotListed: string;
  /** A pass already used: whose it is and when they came in. */
  readonly passUsed: (name: string, at: string | null) => string;
  readonly passOffline: string;
  readonly passType: (name: string) => string;
  readonly table: (table: string) => string;
}

export interface DoorCheckInScreenProps {
  readonly status: ScreenStatus;
  readonly labels: DoorCheckInScreenLabels;
  /** The door list, searched by the app as the person types. */
  readonly guests: readonly DoorGuest[];
  /** A pass the camera read on the Scan tab: its guest's check-in opens once the door list has loaded. */
  readonly scannedPass?: string | null;
  readonly search: string;
  readonly onSearch: (value: string) => void;
  readonly onCheckIn: Action<[entryId: string, plusOnesAdmitted: number, door: string | null]>;
  readonly refreshing?: boolean;
  readonly onRefresh?: () => void;
  readonly onRetry?: () => void;
  readonly errorReference?: string;
}

/**
 * Compass door check-in: search the guest list and admit a guest with their plus-ones. A guest's pass (B8, XOSGP1:<code>,
 * scanned on the Scan tab or typed here) finds them in the loaded door list and opens their check-in; a pass not on the
 * list or already used says so, and without a loaded list (offline) the door is asked to connect first.
 */
export function DoorCheckInScreen({
  status,
  labels,
  guests,
  scannedPass,
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
  const [pass, setPass] = useState("");
  const [passNotice, setPassNotice] = useState<string | null>(null);
  const { busy, run, alert } = useActionRunner(labels.failed);
  const openPass = (raw: string): boolean => {
    const code = passCodeFromScan(raw);
    if (status !== "ready") {
      setPassNotice(labels.passOffline);
      return false;
    }
    const found = code ? guestByPassCode(guests, code) : undefined;
    if (!found) {
      setPassNotice(labels.passNotListed);
      return false;
    }
    if (found.state !== "Approved") {
      setPassNotice(labels.passUsed(found.name, found.checkedInAt));
      return false;
    }
    setPassNotice(null);
    setPlus(found.plusOnes);
    setGuest(found);
    return true;
  };
  const checkPass = () => {
    if (openPass(pass)) setPass("");
  };
  // A pass scanned on the Scan tab is answered once, when the list holding it has loaded; an offline door says so and
  // answers on the retry.
  const answered = useRef(false);
  useEffect(() => {
    if (!scannedPass || answered.current) return;
    if (status === "ready") {
      answered.current = true;
      openPass(scannedPass);
    }
    // openPass reads the current list and labels; only the scan and the list arriving start it.
  }, [scannedPass, status, guests]);
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
      // The door list is read online; without it no pass can be checked, which the error state says.
      labels={
        status === "error"
          ? { ...labels, errorSentence: `${labels.errorSentence} ${labels.passOffline}` }
          : labels
      }
      testID="workforce-door"
      {...defined({ refreshing, onRefresh, onRetry, errorReference })}
    >
      <TextField
        label={labels.pass}
        help={labels.passHelp}
        value={pass}
        onChangeText={(value) => {
          setPass(value);
          setPassNotice(null);
        }}
      />
      <Button
        testID="door-check-pass"
        label={labels.checkPass}
        variant="secondary"
        icon="scan-line"
        block
        disabled={pass.trim() === ""}
        onPress={checkPass}
      />
      {passNotice ? <Banner tone="warning" icon="triangle-alert" message={passNotice} /> : null}
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
              {g.passCategoryName || g.tableLabel ? (
                <Text variant="text13" tone="secondary">
                  {[
                    g.passCategoryName ? labels.passType(g.passCategoryName) : null,
                    g.tableLabel ? labels.table(g.tableLabel) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
              ) : null}
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
          {guest?.passCategoryName ? (
            <Text variant="text13">{labels.passType(guest.passCategoryName)}</Text>
          ) : null}
          {guest?.tableLabel ? (
            <Text variant="text13">{labels.table(guest.tableLabel)}</Text>
          ) : null}
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
