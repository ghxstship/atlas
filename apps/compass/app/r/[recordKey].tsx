import type { XosClient } from "@xos/data/client";
import { getRecordByKey, type RecordSummary } from "@xos/data/work";
import * as Linking from "expo-linking";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { nativeScreenFor, recordTargetFromParams, webFallbackUrl } from "../../src/domain/handoff";
import { useCompass } from "../../src/runtime/CompassProvider";
import { formatDay, LoadError } from "../../src/screens/common";
import { Button, Card, ListRow, Screen, Skeleton, Tag, Text } from "../../src/ui";

type Loaded =
  | { readonly kind: "loading" }
  | { readonly kind: "record"; readonly org: string; readonly record: RecordSummary }
  | { readonly kind: "missing"; readonly org: string | null }
  | { readonly kind: "error"; readonly message: string };

/**
 * A record handed off from Atlas (compass://r/{recordKey}?org={org}, Section 11.10 item 13, ADR 0030).
 * Compass reads the record under the person's own row level security and shows the same record: key,
 * kind, state and title. A kind Compass has a screen for opens that screen in one tap; every record can
 * still open on Atlas. A record the person may not read shows only its key and the way to Atlas.
 */
export default function RecordHandoff(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const params = useLocalSearchParams<{ recordKey: string; org?: string }>();
  const { client, config, resolved } = useCompass();
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const recordKey = params.recordKey ?? "";

  const load = useCallback(async () => {
    setLoaded({ kind: "loading" });
    const orgs = client.from("organizations").select("id, slug");
    const org = await (
      params.org ? orgs.eq("slug", params.org) : orgs.eq("id", resolved?.orgId ?? "")
    ).maybeSingle();
    if (org.error) return setLoaded({ kind: "error", message: org.error.message });
    if (!org.data) return setLoaded({ kind: "missing", org: params.org ?? null });
    const slug = String(org.data.slug);
    const result = await getRecordByKey(
      client as unknown as XosClient,
      String(org.data.id),
      recordKey,
    );
    if (result.ok) return setLoaded({ kind: "record", org: slug, record: result.data });
    if (result.error.kind === "not-found") return setLoaded({ kind: "missing", org: slug });
    return setLoaded({ kind: "error", message: result.error.kind });
  }, [client, params.org, recordKey, resolved?.orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const org = loaded.kind === "record" || loaded.kind === "missing" ? loaded.org : null;
  const target = recordTargetFromParams(params, org);
  const openWeb = target ? () => void Linking.openURL(webFallbackUrl(target, config)) : undefined;

  if (loaded.kind === "loading") {
    return (
      <Screen testID="record-loading" title={recordKey}>
        <Skeleton lines={4} />
      </Screen>
    );
  }
  if (loaded.kind === "error") {
    return (
      <Screen testID="record-error" title={recordKey}>
        <LoadError what={recordKey} onRetry={() => void load()} />
      </Screen>
    );
  }
  if (loaded.kind === "missing") {
    return (
      <Screen testID="record-link" title={recordKey}>
        <Text tone="secondary">{t("compass.record.missing", { key: recordKey })}</Text>
        {openWeb ? (
          <Button
            testID="record-open"
            label={t("compass.common.openAtlas")}
            icon="file-text"
            onPress={openWeb}
          />
        ) : null}
      </Screen>
    );
  }

  const { record } = loaded;
  const screen = nativeScreenFor(record.kind);
  const dated = record.dueAt ?? record.startsAt;
  return (
    <Screen testID={screen ? "record-native" : "record-link"} title={record.key}>
      <Card testID="record-card">
        <Text testID="record-key" variant="mono13" tone="secondary">
          {record.key}
        </Text>
        <Text testID="record-title" variant="heading20" heading>
          {record.title}
        </Text>
        <Tag label={t(`work.kinds.${record.kind}`)} testID="record-kind" />
        <Tag tone="accent" label={t(`work.states.${record.state}`)} testID="record-state" />
      </Card>
      <ListRow
        icon="map"
        title={`${record.projectKey} · ${record.projectName}`}
        subtitle={t("compass.common.project")}
      />
      {dated ? (
        <ListRow
          icon="calendar"
          title={formatDay(dated, record.timeZone)}
          subtitle={t(record.dueAt ? "compass.record.due" : "compass.record.starts")}
        />
      ) : null}
      {record.ownerName ? (
        <ListRow icon="user" title={record.ownerName} subtitle={t("compass.record.owner")} />
      ) : null}
      {screen ? (
        <Button
          testID="record-open-native"
          label={t(screen.label)}
          icon={screen.icon}
          onPress={() => router.push(screen.route as never)}
        />
      ) : (
        <Text tone="secondary">{t("compass.record.sentence", { key: record.key })}</Text>
      )}
      {openWeb ? (
        <Button
          testID="record-open"
          variant={screen ? "secondary" : "primary"}
          label={t("compass.common.openAtlas")}
          icon="file-text"
          onPress={openWeb}
        />
      ) : null}
    </Screen>
  );
}
