import { useState, type ReactElement } from "react";
import { Button, Card, Checkbox, Tag, Text } from "@xos/ui-native";
import {
  REACTION_CODES,
  type FeedPost,
  type FeedPostKind,
  type Poll,
} from "@xos/data/workforce-feed";
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

export type ReactionCode = (typeof REACTION_CODES)[number];

export interface FeedScreenLabels extends FrameLabels {
  readonly empty: string;
  readonly emptyAction: string;
  readonly failed: string;
  readonly pinned: string;
  readonly mustAcknowledge: string;
  readonly acknowledge: string;
  readonly acknowledged: string;
  readonly vote: string;
  readonly voted: string;
  readonly comments: string;
  readonly kinds: Readonly<Record<FeedPostKind, string>>;
  /** A reaction button: its name, the count and whether the viewer reacted. */
  readonly reaction: (code: ReactionCode, count: number, mine: boolean) => string;
  /** The byline: author (or null when unknown) and the published time. */
  readonly byline: (author: string | null, publishAt: string) => string;
}

export interface FeedScreenProps {
  readonly status: ScreenStatus;
  readonly labels: FeedScreenLabels;
  /** Posts in feed order (pinned first), as listFeedPosts returns them. */
  readonly posts: readonly FeedPost[];
  readonly onAcknowledge: Action<[postId: string]>;
  readonly onReact: Action<[postId: string, code: ReactionCode]>;
  readonly onVote: Action<[pollId: string, optionIds: readonly string[]]>;
  /** Opens a post's comments, when the post allows them. */
  readonly onOpenComments?: (postId: string) => void;
  /** The empty state's action, such as opening notification settings. */
  readonly onEmptyAction?: () => void;
  readonly refreshing?: boolean;
  readonly onRefresh?: () => void;
  readonly onRetry?: () => void;
  readonly errorReference?: string;
}

function PollBlock({
  poll,
  labels,
  busy,
  onVote,
}: {
  poll: Poll;
  labels: FeedScreenLabels;
  busy: boolean;
  onVote: (optionIds: readonly string[]) => void;
}): ReactElement {
  const [chosen, setChosen] = useState<readonly string[]>(poll.myChoices);
  const voted = poll.myChoices.length > 0;
  return (
    <Stack>
      <Text variant="label13">{poll.question}</Text>
      {poll.options.map((o) =>
        poll.allowsMultiple ? (
          <Checkbox
            key={o.id}
            label={o.label}
            checked={chosen.includes(o.id)}
            disabled={voted}
            onChange={(on) =>
              setChosen(on ? [...chosen, o.id] : chosen.filter((id) => id !== o.id))
            }
          />
        ) : (
          <Button
            key={o.id}
            label={o.label}
            variant={poll.myChoices.includes(o.id) ? "primary" : "secondary"}
            disabled={voted || busy}
            block
            onPress={() => onVote([o.id])}
          />
        ),
      )}
      {voted ? (
        <Tag tone="success" label={labels.voted} />
      ) : poll.allowsMultiple ? (
        <Button
          label={labels.vote}
          variant="primary"
          disabled={chosen.length === 0}
          loading={busy}
          onPress={() => onVote(chosen)}
        />
      ) : null}
    </Stack>
  );
}

/** Compass Feed: announcements, updates and polls, with acknowledgment and reactions. */
export function FeedScreen({
  status,
  labels,
  posts,
  onAcknowledge,
  onReact,
  onVote,
  onOpenComments,
  onEmptyAction,
  refreshing,
  onRefresh,
  onRetry,
  errorReference,
}: FeedScreenProps): ReactElement {
  const { busy, run, alert } = useActionRunner(labels.failed);
  return (
    <WorkforceFrame
      status={status}
      labels={labels}
      testID="workforce-feed"
      {...defined({ refreshing, onRefresh, onRetry, errorReference })}
    >
      {alert}
      {posts.length === 0 ? (
        <Empty sentence={labels.empty} actionLabel={labels.emptyAction} onAction={onEmptyAction} />
      ) : (
        posts.map((post) => (
          <Card
            key={post.id}
            title={post.title ?? labels.kinds[post.kind]}
            meta={labels.byline(post.authorName, post.publishAt)}
          >
            <Stack>
              <Stack row>
                <Tag label={labels.kinds[post.kind]} />
                {post.pinnedAt !== null ? <Tag tone="accent" label={labels.pinned} /> : null}
                {post.requiresAcknowledgment && !post.acknowledgedByMe ? (
                  <Tag tone="warning" label={labels.mustAcknowledge} />
                ) : null}
              </Stack>
              <Text>{post.body}</Text>
              {post.poll !== null ? (
                <PollBlock
                  poll={post.poll}
                  labels={labels}
                  busy={busy === `vote:${post.poll.id}`}
                  onVote={(ids) => {
                    const pollId = post.poll?.id ?? "";
                    void run(`vote:${pollId}`, () => onVote(pollId, ids));
                  }}
                />
              ) : null}
              {post.requiresAcknowledgment ? (
                post.acknowledgedByMe ? (
                  <Tag tone="success" label={labels.acknowledged} />
                ) : (
                  <Button
                    label={labels.acknowledge}
                    variant="primary"
                    icon="check"
                    block
                    loading={busy === `ack:${post.id}`}
                    onPress={() => void run(`ack:${post.id}`, () => onAcknowledge(post.id))}
                  />
                )
              ) : null}
              {post.reactionsEnabled ? (
                <Stack row>
                  {REACTION_CODES.map((code) => {
                    const mine = post.myReactions.includes(code);
                    return (
                      <Button
                        key={code}
                        label={labels.reaction(code, post.reactions[code] ?? 0, mine)}
                        variant={mine ? "primary" : "ghost"}
                        disabled={busy === `react:${post.id}`}
                        onPress={() => void run(`react:${post.id}`, () => onReact(post.id, code))}
                      />
                    );
                  })}
                </Stack>
              ) : null}
              {post.commentsEnabled && onOpenComments !== undefined ? (
                <Button
                  label={labels.comments}
                  variant="ghost"
                  icon="message-square"
                  onPress={() => onOpenComments(post.id)}
                />
              ) : null}
            </Stack>
          </Card>
        ))
      )}
    </WorkforceFrame>
  );
}
