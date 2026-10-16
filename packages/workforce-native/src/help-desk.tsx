import { useState, type ReactElement } from "react";
import {
  Button,
  ListRow,
  SegmentedControl,
  Sheet,
  StateChip,
  Text,
  TextField,
} from "@xos/ui-native";
import {
  SUPPORT_CATEGORIES,
  responseOverdue,
  type HelpDeskRequest,
  type SupportCategory,
  type SupportTicketState,
} from "@xos/data/workforce-help-desk";
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

export interface HelpDeskScreenLabels extends FrameLabels {
  readonly empty: string;
  readonly ask: string;
  readonly failed: string;
  readonly sheetTitle: string;
  readonly close: string;
  readonly team: string;
  readonly category: string;
  readonly subject: string;
  readonly body: string;
  readonly send: string;
  readonly overdue: string;
  readonly states: Readonly<Record<SupportTicketState, string>>;
  readonly categories: Readonly<Record<SupportCategory, string>>;
  /** Row subtitle: request number, assignee (or null) and created time. */
  readonly meta: (number: string, assignee: string | null, createdAt: string) => string;
}

export interface HelpDeskScreenProps {
  readonly status: ScreenStatus;
  readonly labels: HelpDeskScreenLabels;
  /** The viewer's own requests, newest first. */
  readonly requests: readonly HelpDeskRequest[];
  /** Active help desk teams to ask. */
  readonly teams: readonly { id: string; name: string }[];
  readonly onOpenRequest: (requestId: string) => void;
  readonly onAsk: Action<
    [teamId: string, category: SupportCategory, subject: string, body: string]
  >;
  readonly now?: Date;
  readonly refreshing?: boolean;
  readonly onRefresh?: () => void;
  readonly onRetry?: () => void;
  readonly errorReference?: string;
}

const STATE_CHIP = {
  Open: "active",
  Waiting: "blocked",
  Resolved: "complete",
  Closed: "canceled",
} as const;

/** Compass Help Desk: the viewer's requests and a sheet to ask an internal team. */
export function HelpDeskScreen({
  status,
  labels,
  requests,
  teams,
  onOpenRequest,
  onAsk,
  now,
  refreshing,
  onRefresh,
  onRetry,
  errorReference,
}: HelpDeskScreenProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [picked, setTeam] = useState("");
  const team = teams.some((t) => t.id === picked) ? picked : (teams[0]?.id ?? "");
  const [category, setCategory] = useState<SupportCategory>("Question");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const { busy, run, alert } = useActionRunner(labels.failed);
  const close = () => {
    setOpen(false);
    setSubject("");
    setBody("");
  };
  const send = async () => {
    if (await run("ask", () => onAsk(team, category, subject.trim(), body.trim()))) close();
  };
  return (
    <WorkforceFrame
      status={status}
      labels={labels}
      testID="workforce-help-desk"
      footer={
        teams.length > 0 ? (
          <Button
            label={labels.ask}
            variant="primary"
            icon="life-buoy"
            block
            onPress={() => setOpen(true)}
          />
        ) : undefined
      }
      {...defined({ refreshing, onRefresh, onRetry, errorReference })}
    >
      {requests.length === 0 ? (
        <Empty
          sentence={labels.empty}
          actionLabel={labels.ask}
          {...(teams.length > 0 ? { onAction: () => setOpen(true) } : {})}
        />
      ) : (
        requests.map((r) => (
          <ListRow
            key={r.id}
            title={r.subject}
            subtitle={labels.meta(r.number, r.assigneeName, r.createdAt)}
            onPress={() => onOpenRequest(r.id)}
            trailing={
              <Stack>
                <StateChip state={STATE_CHIP[r.state]} label={labels.states[r.state]} compact />
                {responseOverdue(r, now) ? (
                  <Text variant="text12" tone="danger">
                    {labels.overdue}
                  </Text>
                ) : null}
              </Stack>
            }
          />
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
            disabled={team === "" || subject.trim() === "" || body.trim() === ""}
            loading={busy === "ask"}
            onPress={() => void send()}
          />
        }
      >
        <Stack>
          {alert}
          <SegmentedControl
            label={labels.team}
            value={team}
            options={teams.map((t) => ({ value: t.id, label: t.name }))}
            onChange={setTeam}
          />
          <SegmentedControl
            label={labels.category}
            value={category}
            options={SUPPORT_CATEGORIES.map((c) => ({
              value: c,
              label: labels.categories[c],
            }))}
            onChange={(v) => setCategory(v as SupportCategory)}
          />
          <TextField label={labels.subject} value={subject} onChangeText={setSubject} />
          <TextField label={labels.body} value={body} onChangeText={setBody} multiline />
        </Stack>
      </Sheet>
    </WorkforceFrame>
  );
}
