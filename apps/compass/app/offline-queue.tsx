import type { Mutation } from "@xos/sync";
import { useRouter } from "expo-router";
import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useCompass } from "../src/runtime/CompassProvider";
import { Button, Card, EmptyState, Screen, Sheet, SyncConflictSheet, Tag, Text } from "../src/ui";

function describe(row: Readonly<Record<string, unknown>> | null): string {
  if (!row) return "";
  const shown = Object.entries(row).filter(
    ([k, v]) => k !== "id" && !k.startsWith("p_") && v !== null && typeof v !== "object",
  );
  return shown
    .slice(0, 4)
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${String(v)}`)
    .join(" · ");
}

/**
 * The visible queue (Section 13): every write waiting to upload, with conflicts settled in a resolution
 * sheet that shows the device's version beside the server's.
 */
export default function OfflineQueue(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const { engine, store, status } = useCompass();
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
            <Text variant="text13" tone="tertiary">
              {new Date(m.queuedAt).toLocaleString()}
            </Text>
            {m.lastError ? (
              <Text tone="secondary">
                {t("compass.queue.refusedMessage", { reason: plainReason(m.lastError.message) })}
              </Text>
            ) : null}
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
            message={
              open.lastError
                ? t("compass.queue.refusedMessage", { reason: plainReason(open.lastError.message) })
                : t("compass.queue.conflictMessage")
            }
            field={kind(open)}
            mine={describe(open.payload)}
            mineMeta={t("compass.queue.mineMeta", {
              time: new Date(open.queuedAt).toLocaleTimeString(),
            })}
            theirs={open.serverRow ? describe(open.serverRow) : t("compass.queue.noServerVersion")}
            theirsMeta={t("compass.queue.theirsMeta")}
            onKeepMine={() => {
              void engine?.outbox.resolve(open.id, { action: "retry" }).then(() => engine.drain());
              setOpen(null);
            }}
            onKeepTheirs={() => {
              void engine?.outbox.resolve(open.id, { action: "discard" });
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

/** Server refusals read "rule_code: sentence"; people see the sentence, not the rule code. */
function plainReason(message: string): string {
  return message.replace(/^[a-z][a-z0-9_]*:\s+/, "");
}
