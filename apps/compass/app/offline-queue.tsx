import type { Mutation } from "@xos/sync";
import { useRouter } from "expo-router";
import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  summarizeMutation,
  refusalReason,
  summarizeServerRow,
  type QueueSummary,
  type SummaryContext,
} from "../src/domain/queue-summary";
import { useCompass, useRows } from "../src/runtime/CompassProvider";
import { formatDay, formatTime } from "../src/screens/common";
import { Button, Card, EmptyState, Screen, Sheet, SyncConflictSheet, Tag, Text } from "../src/ui";

/**
 * The visible queue (Section 13): every write waiting to upload, with conflicts settled in a resolution
 * sheet that shows the device's version beside the server's.
 */
export default function OfflineQueue(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const { engine, store, status, resolved } = useCompass();
  const { rows: zones } = useRows<{ id: string; name: string }>("zones");
  const [queue, setQueue] = useState<Mutation[]>([]);
  const [open, setOpen] = useState<Mutation | null>(null);
  useEffect(() => {
    if (!engine || !store) return undefined;
    const read = () => void engine.outbox.all().then(setQueue);
    read();
    return store.subscribe((table) => {
      if (table === "_outbox") read();
    });
  }, [engine, store]);
  const kind = (m: Mutation) => t(`compass.queue.kinds.${m.table}`, { defaultValue: m.table });
  const ctx: SummaryContext = {
    time: formatTime,
    day: formatDay,
    projectName: (id) => resolved?.projects.find((p) => p.id === id)?.name ?? null,
    zoneName: (id) => zones.find((z) => z.id === id)?.name ?? null,
    punchAction: (k) => t(`compass.queue.punchActions.${PUNCH_ACTION[k] ?? "in"}`),
    kind: (table) => t(`compass.queue.kinds.${table}`, { defaultValue: t("compass.queue.field") }),
  };
  const say = (s: QueueSummary) => t(`compass.queue.summary.${s.key}`, s.values);
  const refused = (e: { code: string; message: string }) => {
    const r = refusalReason(e);
    return r.key === "refusedReason"
      ? t("compass.queue.refusedMessage", r.values)
      : t(`compass.queue.${r.key}`);
  };
  return (
    <Screen
      testID="offline-queue"
      title={t("compass.queue.title")}
      footer={
        queue.length > 0 && status?.online ? (
          <Button
            testID="queue-upload"
            size="lg"
            block
            label={t("compass.queue.uploadNow")}
            onPress={() => void engine?.drain()}
          />
        ) : undefined
      }
    >
      {queue.length === 0 ? (
        <EmptyState
          testID="queue-empty"
          icon="refresh-cw"
          sentence={t("compass.queue.empty")}
          actionLabel={t("compass.queue.emptyAction")}
          onAction={() => router.navigate("/today")}
        />
      ) : (
        queue.map((m) => (
          <Card
            key={m.id}
            testID={`queue-${m.id}`}
            title={kind(m)}
            meta={
              <Tag
                label={
                  m.status === "conflict"
                    ? t("compass.queue.conflict")
                    : m.attempts > 0
                      ? t("compass.queue.retrying", { attempts: m.attempts })
                      : t("compass.queue.pending")
                }
                tone={m.status === "conflict" ? "danger" : "neutral"}
              />
            }
            {...(m.status === "conflict" ? { onPress: () => setOpen(m) } : {})}
          >
            <Text testID={`queue-summary-${m.id}`}>{say(summarizeMutation(m, ctx))}</Text>
            <Text variant="text13" tone="tertiary">
              {t("compass.queue.mineMeta", { time: new Date(m.queuedAt).toLocaleString() })}
            </Text>
            {m.lastError ? <Text tone="secondary">{refused(m.lastError)}</Text> : null}
          </Card>
        ))
      )}
      <Sheet
        open={open !== null}
        title={t("compass.queue.conflictTitle")}
        closeLabel={t("compass.common.close")}
        onClose={() => setOpen(null)}
      >
        {open ? (
          <SyncConflictSheet
            testID="conflict-sheet"
            message={open.lastError ? refused(open.lastError) : t("compass.queue.conflictMessage")}
            field={kind(open)}
            mine={say(summarizeMutation(open, ctx))}
            mineMeta={t("compass.queue.mineMeta", {
              time: new Date(open.queuedAt).toLocaleTimeString(),
            })}
            theirs={
              open.serverRow
                ? say(summarizeServerRow(open.table, open.serverRow, ctx))
                : t("compass.queue.noServerVersion")
            }
            theirsMeta={t("compass.queue.theirsMeta")}
            onKeepMine={() => {
              void engine?.outbox.resolve(open.id, { action: "retry" }).then(() => engine.drain());
              setOpen(null);
            }}
            onKeepTheirs={() => {
              void engine?.outbox
                .resolve(open.id, { action: "discard" })
                .then(() => engine.drain());
              setOpen(null);
            }}
            labels={{
              mine: t("compass.queue.mine"),
              theirs: t("compass.queue.theirs"),
              keepMine: t("compass.queue.keepMine"),
              keepTheirs: t("compass.queue.keepTheirs"),
            }}
          />
        ) : null}
      </Sheet>
    </Screen>
  );
}

/** Punch kinds as the database spells them, mapped to their compass.queue.punchActions keys. */
const PUNCH_ACTION: Readonly<Record<string, string>> = {
  In: "in",
  "Break Start": "breakStart",
  "Break End": "breakEnd",
  Out: "out",
};
