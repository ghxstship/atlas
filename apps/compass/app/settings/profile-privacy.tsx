import { listMyBlocks, unblock, type Block } from "@xos/data/access-controls";
import type { XosClient } from "@xos/data/client";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useCompass } from "../../src/runtime/CompassProvider";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  InlineAlert,
  Screen,
  Skeleton,
  Tag,
  Text,
} from "../../src/ui";

type Load =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "ready"; readonly blocks: readonly Block[] };

/**
 * Settings, Profile Privacy (sitemap settings.profile-privacy): the people, and organizations blocked from Gateway,
 * that the person blocked, each with Unblock (ADR 0033 decision 57, Section 4.5.6). A block hides the person's posts,
 * comments, shout-outs and messages from this person (migration 1631); unblocking shows them again. Online only.
 */
export default function BlockedPeopleScreen(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const { client, network } = useCompass();
  const db = client as unknown as XosClient;
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  const read = useCallback(async () => {
    const result = await listMyBlocks(db);
    setLoad(result.ok ? { kind: "ready", blocks: result.data } : { kind: "failed" });
  }, [db]);

  useEffect(() => {
    if (network.isConnected) void read();
  }, [network.isConnected, read]);

  const lift = async (block: Block) => {
    const name = block.name ?? t("compass.safety.someone");
    setBusy(block.id);
    setMessage(null);
    const result = await unblock(db, block.id);
    setBusy(null);
    if (result.ok) {
      setMessage({ tone: "success", text: t("compass.blocked.unblocked", { name }) });
      await read();
    } else {
      setMessage({ tone: "danger", text: t("compass.blocked.failed", { name }) });
    }
  };

  return (
    <Screen testID="blocked-people" title={t("compass.blocked.title")}>
      <Text tone="secondary">{t("compass.blocked.intro")}</Text>
      {message ? (
        <InlineAlert testID="blocked-message" tone={message.tone} message={message.text} />
      ) : null}
      {!network.isConnected ? (
        <InlineAlert
          testID="blocked-offline"
          tone="warning"
          message={t("compass.blocked.offline")}
        />
      ) : load.kind === "loading" ? (
        <Skeleton testID="blocked-loading" height={20} lines={3} />
      ) : load.kind === "failed" ? (
        <ErrorState
          testID="blocked-error"
          title={t("compass.blocked.loadFailed")}
          sentence={t("compass.blocked.loadFailedSentence")}
          actionLabel={t("compass.blocked.retry")}
          onRetry={() => void read()}
        />
      ) : load.blocks.length === 0 ? (
        <EmptyState
          testID="blocked-empty"
          icon="users"
          sentence={t("compass.blocked.empty")}
          actionLabel={t("compass.blocked.back")}
          onAction={() => router.back()}
        />
      ) : (
        load.blocks.map((block) => {
          const name = block.name ?? t("compass.safety.someone");
          return (
            <Card
              key={block.id}
              title={name}
              footer={
                <Button
                  testID="blocked-unblock"
                  label={t("compass.blocked.unblock", { name })}
                  variant="secondary"
                  loading={busy === block.id}
                  disabled={busy !== null}
                  onPress={() => void lift(block)}
                />
              }
            >
              {block.kind === "organization" ? (
                <Tag label={t("compass.blocked.organization")} />
              ) : null}
            </Card>
          );
        })
      )}
    </Screen>
  );
}
