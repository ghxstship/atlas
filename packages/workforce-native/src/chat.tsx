import { useState, type ReactElement } from "react";
import { Badge, Button, Card, ListRow, Tag, Text, TextField } from "@xos/ui-native";
import type { ChatMessage, ConversationSummary } from "@xos/data/workforce-chat";
import {
  ContentActionsButton,
  Empty,
  Stack,
  WorkforceFrame,
  defined,
  titled,
  useActionRunner,
  type Action,
  type ContentActions,
  type FrameLabels,
  type ScreenStatus,
} from "./shared.tsx";

export interface ConversationsScreenLabels extends FrameLabels {
  readonly empty: string;
  readonly newMessage: string;
  readonly muted: string;
  readonly noMessages: string;
  readonly unread: (count: number) => string;
}

export interface ConversationsScreenProps {
  readonly status: ScreenStatus;
  readonly labels: ConversationsScreenLabels;
  readonly conversations: readonly ConversationSummary[];
  readonly onOpen: (conversationId: string) => void;
  /** Starts a direct message, usually by opening the directory. */
  readonly onNewMessage: () => void;
  readonly refreshing?: boolean;
  readonly onRefresh?: () => void;
  readonly onRetry?: () => void;
  readonly errorReference?: string;
}

/** Compass Messages: direct and group conversations, newest first, with unread counts. */
export function ConversationsScreen({
  status,
  labels,
  conversations,
  onOpen,
  onNewMessage,
  refreshing,
  onRefresh,
  onRetry,
  errorReference,
}: ConversationsScreenProps): ReactElement {
  return (
    <WorkforceFrame
      status={status}
      labels={labels}
      testID="workforce-conversations"
      footer={
        <Button
          label={labels.newMessage}
          variant="primary"
          icon="plus"
          block
          onPress={onNewMessage}
        />
      }
      {...defined({ refreshing, onRefresh, onRetry, errorReference })}
    >
      {conversations.length === 0 ? (
        <Empty sentence={labels.empty} actionLabel={labels.newMessage} onAction={onNewMessage} />
      ) : (
        conversations.map((c) => (
          <ListRow
            key={c.id}
            title={c.title}
            subtitle={c.lastMessageBody ?? labels.noMessages}
            icon={c.kind === "Group" ? "users" : "message-square"}
            onPress={() => onOpen(c.id)}
            trailing={
              c.muted ? (
                <Tag label={labels.muted} />
              ) : c.unread > 0 ? (
                <Badge count={c.unread} tone="accent" label={labels.unread(c.unread)} />
              ) : undefined
            }
          />
        ))
      )}
    </WorkforceFrame>
  );
}

export interface ChatThreadScreenLabels extends FrameLabels {
  readonly empty: string;
  readonly message: string;
  readonly send: string;
  readonly failed: string;
  readonly edited: string;
  readonly you: string;
  readonly someone: string;
  readonly attachment: string;
  /** Message meta: author and time. */
  readonly meta: (author: string, createdAt: string) => string;
  /** Read receipt line for the viewer's newest message, when read receipts are on. */
  readonly readBy?: string;
}

export interface ChatThreadScreenProps {
  readonly status: ScreenStatus;
  readonly labels: ChatThreadScreenLabels;
  readonly title: string;
  /** Oldest first, as listMessages returns them. */
  readonly messages: readonly ChatMessage[];
  readonly myMembershipIds: readonly string[];
  readonly onSend: Action<[body: string]>;
  /** Opens a photo, file or voice note attached to a message. */
  readonly onOpenAttachment?: (messageId: string) => void;
  /** Report and block on messages by someone else (ADR 0033 decision 57); absent, no message shows the button. */
  readonly contentActions?: ContentActions;
  readonly refreshing?: boolean;
  readonly onRefresh?: () => void;
  readonly onRetry?: () => void;
  readonly errorReference?: string;
}

/** Compass conversation: messages oldest first and a composer pinned at the bottom. */
export function ChatThreadScreen({
  status,
  labels,
  title,
  messages,
  myMembershipIds,
  onSend,
  onOpenAttachment,
  contentActions,
  refreshing,
  onRefresh,
  onRetry,
  errorReference,
}: ChatThreadScreenProps): ReactElement {
  const [draft, setDraft] = useState("");
  const { busy, run, alert } = useActionRunner(labels.failed);
  const body = draft.trim();
  const send = async () => {
    if (await run("send", () => onSend(body))) setDraft("");
  };
  return (
    <WorkforceFrame
      status={status}
      labels={titled(labels, title)}
      testID="workforce-chat-thread"
      footer={
        <Stack>
          {alert}
          <TextField label={labels.message} value={draft} onChangeText={setDraft} multiline />
          <Button
            label={labels.send}
            variant="primary"
            icon="send"
            block
            disabled={body === ""}
            loading={busy === "send"}
            onPress={() => void send()}
          />
        </Stack>
      }
      {...defined({ refreshing, onRefresh, onRetry, errorReference })}
    >
      {messages.length === 0 ? (
        <Text tone="secondary">{labels.empty}</Text>
      ) : (
        messages.map((m) => {
          const mine = myMembershipIds.includes(m.authorMembershipId);
          const author = mine ? labels.you : (m.authorName ?? labels.someone);
          return (
            <Card
              key={m.id}
              footer={
                contentActions !== undefined && !mine ? (
                  <ContentActionsButton
                    actions={contentActions}
                    target={{
                      kind: "Chat Message",
                      id: m.id,
                      authorMembershipId: m.authorMembershipId,
                      authorName: m.authorName,
                    }}
                  />
                ) : undefined
              }
            >
              <Stack>
                <Text variant="text12" tone="secondary">
                  {labels.meta(author, m.createdAt)}
                </Text>
                {m.body !== null ? <Text>{m.body}</Text> : null}
                {m.kind !== "Text" && onOpenAttachment !== undefined ? (
                  <Button
                    label={labels.attachment}
                    variant="ghost"
                    icon="paperclip"
                    onPress={() => onOpenAttachment(m.id)}
                  />
                ) : null}
                {m.editedAt !== null ? (
                  <Text variant="text12" tone="tertiary">
                    {labels.edited}
                  </Text>
                ) : null}
              </Stack>
            </Card>
          );
        })
      )}
      {labels.readBy !== undefined && messages.length > 0 ? (
        <Text variant="text12" tone="secondary">
          {labels.readBy}
        </Text>
      ) : null}
    </WorkforceFrame>
  );
}
