import type { Row } from "@xos/sync";
import { useRouter, type Href } from "expo-router";
import { useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { TextInput, View } from "react-native";
import { access } from "../domain/access";
import {
  groupHits,
  searchLocal,
  type LocalSearchDoc,
  type LocalSearchKind,
} from "../domain/search";
import { searchDocs, type SEARCH_TABLES } from "../domain/searchDocs";
import { scheduleZone } from "../domain/settings";
import { useCompass, useRows } from "../runtime/CompassProvider";
import { Card, Icon, IconButton, ListRow, Text, useTheme } from "../ui";
import { typography } from "../ui/primitives";
import { formatDay, formatTime, useRoleTitle } from "./common";

const ICON: Readonly<Record<LocalSearchKind, string>> = {
  shift: "calendar",
  task: "list-checks",
  record: "file-text",
  person: "user",
  reference: "book-open",
  action: "chevron-right",
};

/**
 * Search at the top of Today (Section 11.10 item 1, A126): shifts, tasks, records, people, reference and
 * actions, found in the device's offline store, so it answers with no signal. The store is read only
 * while there is something typed; src/domain/searchDocs.ts builds what is searched, with the filters of
 * the screens the results open, and src/domain/search.ts ranks it as the command menus do.
 */
export function TodaySearch(): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  const [query, setQuery] = useState("");
  return (
    <View style={{ gap: theme.space["8"] }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: theme.space["8"],
          minHeight: theme.density.touchMin,
          paddingStart: theme.space["12"],
          paddingEnd: theme.space["4"],
          borderRadius: theme.radius.control,
          borderWidth: theme.controlBorderWidth,
          borderColor: theme.color.borderControl,
          backgroundColor: theme.color.bgSurface,
        }}
      >
        <Icon name="search" size={20} tone="secondary" />
        <TextInput
          testID="today-search"
          accessibilityRole="search"
          accessibilityLabel={t("compassSearch.label")}
          placeholder={t("compassSearch.hint")}
          value={query}
          onChangeText={setQuery}
          autoCorrect={false}
          returnKeyType="search"
          maxFontSizeMultiplier={2}
          style={[
            typography(theme, "text16"),
            { flex: 1, paddingVertical: theme.space["8"], color: theme.color.textPrimary },
          ]}
        />
        {query !== "" ? (
          <IconButton
            testID="today-search-clear"
            icon="x"
            label={t("compassSearch.clear")}
            onPress={() => setQuery("")}
          />
        ) : null}
      </View>
      {query.trim() !== "" ? <SearchResults query={query} /> : null}
    </View>
  );
}

/** The rows of each table search reads, from the active org, kept live. */
function useSearchRows(): (table: string) => readonly Row[] {
  const shifts = useRows("shifts").rows;
  const projects = useRows("projects").rows;
  const onboarding = useRows("onboarding_items").rows;
  const deliverables = useRows("deliverables").rows;
  const shared = useRows("shared_records").rows;
  const orders = useRows("purchase_orders").rows;
  const incidents = useRows("incidents").rows;
  const roster = useRows("kiosk_roster").rows;
  const sops = useRows("sops").rows;
  const codes = useRows("emergency_codes").rows;
  const canon = useRows("canon_emergency_codes").rows;
  const channels = useRows("radio_channels").rows;
  return useMemo(() => {
    const byTable: Readonly<Record<(typeof SEARCH_TABLES)[number], readonly Row[]>> = {
      shifts,
      projects,
      onboarding_items: onboarding,
      deliverables,
      shared_records: shared,
      purchase_orders: orders,
      incidents,
      kiosk_roster: roster,
      sops,
      emergency_codes: codes,
      canon_emergency_codes: canon,
      radio_channels: channels,
    };
    return (table: string) => byTable[table as (typeof SEARCH_TABLES)[number]] ?? [];
  }, [
    shifts,
    projects,
    onboarding,
    deliverables,
    shared,
    orders,
    incidents,
    roster,
    sops,
    codes,
    canon,
    channels,
  ]);
}

/** The results for what is typed, from the offline store. Mounted only while there is a query. */
function SearchResults({ query }: { readonly query: string }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const roleTitle = useRoleTitle();
  const { resolved, projectId, orgSettings, status } = useCompass();
  const identity = resolved?.identity;
  const rows = useSearchRows();

  const docs = useMemo((): LocalSearchDoc[] => {
    if (!identity) return [];
    return searchDocs({
      identity,
      projectId,
      rows,
      allowed: (feature) => access(identity, feature, projectId).allowed,
      t: (key, values) => t(key, { ...values }),
      shiftTitle: roleTitle,
      shiftWhen: (s) => {
        const zone = scheduleZone(s.time_zone, orgSettings);
        return t("compassSearch.when", {
          day: formatDay(s.starts_at, zone),
          time: t("compass.schedule.timeRange", {
            start: formatTime(s.starts_at, zone),
            end: formatTime(s.ends_at, zone),
          }),
        });
      },
      now: Date.now(),
    });
  }, [identity, projectId, rows, orgSettings, roleTitle, t]);

  const groups = groupHits(searchLocal(docs, query, { now: Date.now() }));
  const count = groups.reduce((n, g) => n + g.hits.length, 0);
  return (
    <Card testID="today-search-results">
      <View accessibilityLiveRegion="polite">
        <Text variant="text13" tone="secondary" testID="today-search-count">
          {count === 0
            ? t("compassSearch.empty", { query: query.trim() })
            : t(count === 1 ? "compassSearch.countOne" : "compassSearch.countOther", { count })}
          {status && !status.online ? ` ${t("compassSearch.offline")}` : ""}
        </Text>
      </View>
      {groups.map((g) => (
        <View key={g.kind} testID={`search-group-${g.kind}`}>
          <Text variant="label13" tone="secondary" heading>
            {t(`compassSearch.groups.${g.kind}`)}
          </Text>
          {g.hits.map((hit) => (
            <ListRow
              key={`${hit.kind}-${hit.id}`}
              testID={`search-result-${hit.kind}-${hit.id}`}
              icon={ICON[hit.kind]}
              title={hit.title}
              {...(hit.subtitle ? { subtitle: hit.subtitle } : {})}
              onPress={() => router.push(hit.href as Href)}
            />
          ))}
        </View>
      ))}
    </Card>
  );
}
