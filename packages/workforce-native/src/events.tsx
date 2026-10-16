import type { ReactElement } from "react";
import { Button, Card, StateChip, Text } from "@xos/ui-native";
import {
  RSVP_RESPONSES,
  eventPhase,
  myRsvp,
  rsvpCounts,
  type RsvpResponse,
  type WorkforceEvent,
  type WorkforceEventKind,
} from "@xos/data/workforce-events";
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

export interface EventsScreenLabels extends FrameLabels {
  readonly empty: string;
  readonly emptyAction: string;
  readonly failed: string;
  readonly checkIn: string;
  readonly checkedIn: string;
  readonly kinds: Readonly<Record<WorkforceEventKind, string>>;
  readonly responses: Readonly<Record<RsvpResponse, string>>;
  readonly phases: Readonly<Record<"canceled" | "past" | "live" | "upcoming", string>>;
  /** Time and place line. */
  readonly when: (startsAt: string, endsAt: string, location: string | null) => string;
  readonly counts: (counts: Record<RsvpResponse, number>) => string;
}

export interface EventsScreenProps {
  readonly status: ScreenStatus;
  readonly labels: EventsScreenLabels;
  readonly events: readonly WorkforceEvent[];
  readonly myMembershipIds: readonly string[];
  readonly onRsvp: Action<[eventId: string, response: RsvpResponse]>;
  readonly onCheckIn: Action<[eventId: string]>;
  readonly onEmptyAction?: () => void;
  /** The clock the phases are read against; the app passes its own for tests and time zones. */
  readonly now?: Date;
  readonly refreshing?: boolean;
  readonly onRefresh?: () => void;
  readonly onRetry?: () => void;
  readonly errorReference?: string;
}

const PHASE_STATE = {
  canceled: "canceled",
  past: "complete",
  live: "active",
  upcoming: "scheduled",
} as const;

/** Compass Events: briefings, crew calls and meetings with RSVP and check-in. */
export function EventsScreen({
  status,
  labels,
  events,
  myMembershipIds,
  onRsvp,
  onCheckIn,
  onEmptyAction,
  now,
  refreshing,
  onRefresh,
  onRetry,
  errorReference,
}: EventsScreenProps): ReactElement {
  const { busy, run, alert } = useActionRunner(labels.failed);
  return (
    <WorkforceFrame
      status={status}
      labels={labels}
      testID="workforce-events"
      {...defined({ refreshing, onRefresh, onRetry, errorReference })}
    >
      {alert}
      {events.length === 0 ? (
        <Empty sentence={labels.empty} actionLabel={labels.emptyAction} onAction={onEmptyAction} />
      ) : (
        events.map((e) => {
          const phase = eventPhase(e, now);
          const mine = myRsvp(e, myMembershipIds);
          const checkedIn = e.checkIns.some((c) => myMembershipIds.includes(c.membershipId));
          const open = phase === "upcoming" || phase === "live";
          return (
            <Card key={e.id} title={e.title} meta={labels.when(e.startsAt, e.endsAt, e.location)}>
              <Stack>
                <Stack row>
                  <StateChip state={PHASE_STATE[phase]} label={labels.phases[phase]} />
                  <Text variant="text13" tone="secondary">
                    {labels.kinds[e.kind]}
                  </Text>
                </Stack>
                {e.agenda !== null ? <Text>{e.agenda}</Text> : null}
                {phase === "canceled" && e.cancelReason !== null ? (
                  <Text tone="danger">{e.cancelReason}</Text>
                ) : null}
                <Text variant="text13" tone="secondary">
                  {labels.counts(rsvpCounts(e))}
                </Text>
                {open ? (
                  <Stack row>
                    {RSVP_RESPONSES.map((r) => (
                      <Button
                        key={r}
                        label={labels.responses[r]}
                        variant={mine === r ? "primary" : "secondary"}
                        disabled={busy === `rsvp:${e.id}`}
                        onPress={() => void run(`rsvp:${e.id}`, () => onRsvp(e.id, r))}
                      />
                    ))}
                  </Stack>
                ) : null}
                {phase === "live" ? (
                  checkedIn ? (
                    <StateChip state="complete" label={labels.checkedIn} />
                  ) : (
                    <Button
                      label={labels.checkIn}
                      variant="primary"
                      icon="calendar-check"
                      block
                      loading={busy === `check:${e.id}`}
                      onPress={() => void run(`check:${e.id}`, () => onCheckIn(e.id))}
                    />
                  )
                ) : null}
              </Stack>
            </Card>
          );
        })
      )}
    </WorkforceFrame>
  );
}
