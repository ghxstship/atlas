/**
 * One external More screen (A92, Section 4.5.7): the page's sections from the rows on the device, so it reads
 * offline, and one button that opens the engagement's tab in Gateway, where submitting, uploading and signing live.
 */
import { toDisplayKey } from "@xos/data/gateway-keys";
import type { Row } from "@xos/sync";
import * as Linking from "expo-linking";
import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { moreMenu } from "../domain/access";
import { todayOn } from "../domain/dates";
import {
  EXTERNAL_PAGES,
  engagementFor,
  gatewayTabUrl,
  type ExternalItem,
  type ExternalPageId,
} from "../domain/external";
import { factsText } from "../domain/facts";
import { useCompass, useRows } from "../runtime/CompassProvider";
import {
  Button,
  Card,
  EmptyState,
  ListRow,
  ProgressBar,
  Screen,
  Skeleton,
  Tag,
  Text,
  useTheme,
} from "../ui";
import { DenialNotice, ProjectPicker, SyncBanner } from "./common";

/** Rows of several local tables, live: re-read whenever one of them changes. */
function useTables(tables: readonly string[]): (table: string) => readonly Row[] {
  const { store } = useCompass();
  const [rows, setRows] = useState<ReadonlyMap<string, readonly Row[]>>(new Map());
  const key = tables.join(",");
  useEffect(() => {
    if (!store) return undefined;
    let live = true;
    const names = key.split(",");
    const read = () =>
      void Promise.all(names.map((t) => store.list(t))).then((lists) => {
        if (live) setRows(new Map(names.map((t, i) => [t, lists[i] ?? []])));
      });
    read();
    const stop = store.subscribe((changed) => {
      if (names.includes(changed)) read();
    });
    return () => {
      live = false;
      stop();
    };
  }, [store, key]);
  return (table) => rows.get(table) ?? [];
}

function Item({
  item,
  depth,
}: {
  readonly item: ExternalItem;
  readonly depth: number;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const facts = factsText(item.facts, (key, values) => t(key, { ...values }), i18n.language);
  const title = item.title || facts.shift() || "";
  return (
    <View style={{ paddingLeft: depth * theme.space["16"] }}>
      <ListRow
        testID={`external-item-${item.id}`}
        icon={item.icon}
        title={title}
        {...(facts.length > 0 ? { subtitle: facts.join(" · ") } : {})}
        {...(item.tag ? { trailing: <Tag tone={item.tag.tone} label={t(item.tag.key)} /> } : {})}
      />
      {(item.lines ?? []).map((line) => (
        <Item key={line.id} item={line} depth={depth + 1} />
      ))}
    </View>
  );
}

export function ExternalPageScreen({ page: id }: { readonly page: ExternalPageId }): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  const page = EXTERNAL_PAGES[id];
  const { resolved, projectId, config, refresh } = useCompass();
  const rows = useTables(page.tables);
  const { rows: projects } = useRows<Row & { time_zone?: string | null }>("projects");
  const [refreshing, setRefreshing] = useState(false);
  const title = t(`nav.compass.more.${id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())}`);
  if (!resolved) {
    return (
      <Screen testID={`external-${id}`} title={title}>
        <Skeleton lines={4} />
      </Screen>
    );
  }
  const identity = resolved.identity;
  if (!moreMenu(identity.audience).some((m) => m.id === id)) {
    return (
      <Screen testID={`external-${id}`} title={title}>
        <DenialNotice reason="role" />
      </Screen>
    );
  }
  // The engagement's project zone (api_external.projects, on the device); the person's own when it is unknown.
  const zoneOf = (project: string | null | undefined) =>
    projects.find((p) => p.id === project)?.time_zone ?? null;
  const sections = page.build({
    rows,
    projectId,
    personId: identity.personId,
    engagements: identity.engagements,
    zoneOf,
    todayOf: (project) => todayOn(zoneOf(project)),
  });
  const engagement = engagementFor(page, identity.engagements, projectId);
  const openGateway = () => {
    if (!engagement) return;
    void Linking.openURL(
      gatewayTabUrl(config.gatewayUrl, toDisplayKey("engagement", engagement.id), page.gatewayTab),
    );
  };
  return (
    <Screen
      testID={`external-${id}`}
      title={title}
      refreshing={refreshing}
      onRefresh={() => {
        setRefreshing(true);
        void refresh().finally(() => setRefreshing(false));
      }}
      footer={
        engagement ? (
          <View style={{ gap: theme.space["8"] }}>
            <Text variant="text13" tone="secondary">
              {t(`compassExternal.gateway.${page.gatewayTab === "time" ? "time" : "actions"}`)}
            </Text>
            <Button
              testID="external-open-gateway"
              variant="secondary"
              block
              icon="external-link"
              label={t("compass.common.openGateway")}
              onPress={openGateway}
            />
          </View>
        ) : undefined
      }
    >
      <ProjectPicker />
      <SyncBanner />
      {sections.length === 0 ? (
        <EmptyState
          testID={`external-${id}-empty`}
          icon={page.icon}
          sentence={t(page.emptyKey)}
          actionLabel=""
        />
      ) : (
        sections.map((s) => (
          <Card key={s.id} testID={`external-section-${s.id}`} title={t(s.titleKey)}>
            {s.progress ? (
              <ProgressBar
                label={t("compassExternal.progress", {
                  done: s.progress.done,
                  total: s.progress.total,
                })}
                value={s.progress.total > 0 ? (s.progress.done / s.progress.total) * 100 : 0}
              />
            ) : null}
            {s.items.map((item) => (
              <Item key={item.id} item={item} depth={0} />
            ))}
          </Card>
        ))
      )}
    </Screen>
  );
}
