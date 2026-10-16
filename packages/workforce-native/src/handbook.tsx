import { useState, type ReactElement } from "react";
import { Button, InlineAlert, ListRow, Tag, Text, TextField } from "@xos/ui-native";
import type { HandbookArticle } from "@xos/data/workforce-training";
import {
  Empty,
  Section,
  Stack,
  WorkforceFrame,
  defined,
  titled,
  useActionRunner,
  type Action,
  type FrameLabels,
  type ScreenStatus,
} from "./shared.tsx";

export interface HandbookScreenLabels extends FrameLabels {
  readonly search: string;
  readonly empty: string;
  readonly clearSearch: string;
  readonly failed: string;
  readonly mandatory: string;
  readonly mustRead: string;
  readonly allArticles: string;
  readonly acknowledge: string;
  readonly acknowledged: string;
  readonly back: string;
  readonly changes: (summary: string) => string;
}

export interface HandbookScreenProps {
  readonly status: ScreenStatus;
  readonly labels: HandbookScreenLabels;
  /** Published articles the viewer reads (search already applied by the app). */
  readonly articles: readonly HandbookArticle[];
  readonly search: string;
  readonly onSearch: (value: string) => void;
  readonly onAcknowledge: Action<[articleId: string]>;
  readonly refreshing?: boolean;
  readonly onRefresh?: () => void;
  readonly onRetry?: () => void;
  readonly errorReference?: string;
}

/** Compass Handbook: mandatory reads first, search, the article and its acknowledgment. */
export function HandbookScreen({
  status,
  labels,
  articles,
  search,
  onSearch,
  onAcknowledge,
  refreshing,
  onRefresh,
  onRetry,
  errorReference,
}: HandbookScreenProps): ReactElement {
  const [openId, setOpenId] = useState<string | null>(null);
  const { busy, run, alert } = useActionRunner(labels.failed);
  const readable = articles.filter((a) => a.published !== null);
  const open = readable.find((a) => a.id === openId) ?? null;
  const frame = defined({ refreshing, onRefresh, onRetry, errorReference });

  if (open?.published) {
    const text = open.published;
    return (
      <WorkforceFrame
        status={status}
        labels={titled(labels, text.title)}
        testID="workforce-handbook-article"
        footer={
          <Stack>
            {alert}
            {open.mandatory && !open.acknowledgedByMe ? (
              <Button
                label={labels.acknowledge}
                variant="primary"
                icon="check"
                block
                loading={busy === "ack"}
                onPress={() => void run("ack", () => onAcknowledge(open.id))}
              />
            ) : null}
            <Button
              label={labels.back}
              variant="ghost"
              icon="arrow-left"
              onPress={() => setOpenId(null)}
            />
          </Stack>
        }
        {...frame}
      >
        {open.acknowledgedByMe ? (
          <InlineAlert tone="success" message={labels.acknowledged} />
        ) : null}
        {text.changeSummary !== null ? (
          <Text variant="text13" tone="secondary">
            {labels.changes(text.changeSummary)}
          </Text>
        ) : null}
        {text.body.split(/\n{2,}/).map((para, i) => (
          <Text key={i}>{para}</Text>
        ))}
      </WorkforceFrame>
    );
  }

  const mustRead = readable.filter((a) => a.mandatory && !a.acknowledgedByMe);
  const row = (a: HandbookArticle) => (
    <ListRow
      key={a.id}
      title={a.published?.title ?? a.title}
      icon="book-open"
      onPress={() => setOpenId(a.id)}
      trailing={
        a.mandatory ? (
          <Tag
            tone={a.acknowledgedByMe ? "success" : "warning"}
            label={a.acknowledgedByMe ? labels.acknowledged : labels.mandatory}
          />
        ) : undefined
      }
    />
  );
  return (
    <WorkforceFrame status={status} labels={labels} testID="workforce-handbook" {...frame}>
      <TextField label={labels.search} value={search} onChangeText={onSearch} />
      {readable.length === 0 ? (
        <Empty
          sentence={labels.empty}
          actionLabel={labels.clearSearch}
          onAction={() => onSearch("")}
        />
      ) : (
        <>
          {mustRead.length > 0 ? (
            <Section title={labels.mustRead}>{mustRead.map(row)}</Section>
          ) : null}
          <Section title={labels.allArticles}>{readable.map(row)}</Section>
        </>
      )}
    </WorkforceFrame>
  );
}
