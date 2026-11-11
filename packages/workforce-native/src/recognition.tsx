import { useState, type ReactElement } from "react";
import { Button, Card, Sheet, Text, TextField } from "@xos/ui-native";
import type { Recognition } from "@xos/data/workforce-feed";
import {
  ContentActionsButton,
  Empty,
  Stack,
  WorkforceFrame,
  defined,
  useActionRunner,
  type Action,
  type ContentActions,
  type FrameLabels,
  type ScreenStatus,
} from "./shared.tsx";

export interface RecognitionScreenLabels extends FrameLabels {
  readonly empty: string;
  readonly give: string;
  readonly failed: string;
  readonly sheetTitle: string;
  readonly close: string;
  readonly who: string;
  readonly message: string;
  readonly messageHelp: string;
  readonly send: string;
  /** "From Ana to Sam" style line with the time. */
  readonly line: (from: string | null, to: string | null, createdAt: string) => string;
}

export interface RecognitionScreenProps {
  readonly status: ScreenStatus;
  readonly labels: RecognitionScreenLabels;
  readonly recognitions: readonly Recognition[];
  /** People the viewer can recognize, by membership id. */
  readonly people: readonly { membershipId: string; name: string }[];
  readonly onRecognize: Action<[membershipId: string, message: string]>;
  /**
   * Report and block on shout-outs by someone else (ADR 0033 decision 57), reported as their feed post; absent, no
   * shout-out shows the button.
   */
  readonly contentActions?: ContentActions;
  /** The viewer's memberships: shout-outs they gave offer no report or block. */
  readonly myMembershipIds?: readonly string[];
  readonly refreshing?: boolean;
  readonly onRefresh?: () => void;
  readonly onRetry?: () => void;
  readonly errorReference?: string;
}

/** Compass Recognition: the wall of thanks and a sheet to recognize a teammate. */
export function RecognitionScreen({
  status,
  labels,
  recognitions,
  people,
  onRecognize,
  contentActions,
  myMembershipIds = [],
  refreshing,
  onRefresh,
  onRetry,
  errorReference,
}: RecognitionScreenProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const { busy, run, alert } = useActionRunner(labels.failed);
  const close = () => {
    setOpen(false);
    setTo(null);
    setMessage("");
  };
  const send = async () => {
    if (to === null) return;
    if (await run("give", () => onRecognize(to, message.trim()))) close();
  };
  return (
    <WorkforceFrame
      status={status}
      labels={labels}
      testID="workforce-recognition"
      footer={
        <Button
          label={labels.give}
          variant="primary"
          icon="star"
          block
          onPress={() => setOpen(true)}
        />
      }
      {...defined({ refreshing, onRefresh, onRetry, errorReference })}
    >
      {recognitions.length === 0 ? (
        <Empty sentence={labels.empty} actionLabel={labels.give} onAction={() => setOpen(true)} />
      ) : (
        recognitions.map((r) => (
          <Card
            key={r.id}
            footer={
              contentActions !== undefined &&
              r.feedPostId !== null &&
              !myMembershipIds.includes(r.fromMembershipId) ? (
                <ContentActionsButton
                  actions={contentActions}
                  target={{
                    kind: "Feed Post",
                    id: r.feedPostId,
                    authorMembershipId: r.fromMembershipId,
                    authorName: r.fromName,
                  }}
                />
              ) : undefined
            }
          >
            <Stack>
              <Text variant="text12" tone="secondary">
                {labels.line(r.fromName, r.toName, r.createdAt)}
              </Text>
              <Text>{r.message}</Text>
            </Stack>
          </Card>
        ))
      )}
      <Sheet
        open={open}
        title={labels.sheetTitle}
        closeLabel={labels.close}
        onClose={close}
        footer={
          <Button
            label={labels.send}
            variant="primary"
            block
            disabled={to === null || message.trim().length < 3}
            loading={busy === "give"}
            onPress={() => void send()}
          />
        }
      >
        <Stack>
          {alert}
          <Text variant="label13">{labels.who}</Text>
          {people.map((p) => (
            <Button
              key={p.membershipId}
              label={p.name}
              block
              variant={to === p.membershipId ? "primary" : "secondary"}
              onPress={() => setTo(p.membershipId)}
            />
          ))}
          <TextField
            label={labels.message}
            help={labels.messageHelp}
            value={message}
            onChangeText={setMessage}
            multiline
          />
        </Stack>
      </Sheet>
    </WorkforceFrame>
  );
}
