import type { Row } from "@xos/sync";
import { useRouter, type Href } from "expo-router";
import { useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { TextInput, View } from "react-native";
import { access, operationalEngagements, type Feature } from "../domain/access";
import {
  actionDocs,
  groupHits,
  searchLocal,
  type LocalSearchDoc,
  type LocalSearchKind,
} from "../domain/search";
import { scheduleZone } from "../domain/settings";
import { isMine, type ShiftRow } from "../domain/shifts";
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
 * while there is something typed; src/domain/search.ts ranks the results as the command menus do.
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
          placeholderTextColor={theme.color.textTertiary}
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

type Named = Row & { name?: string | null; title?: string | null };

/** The results for what is typed, from the offline store. Mounted only while there is a query. */
function SearchResults({ query }: { readonly query: string }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const roleTitle = useRoleTitle();
  const { resolved, projectId, orgSettings, status } = useCompass();
  const identity = resolved?.identity;
  const { rows: shifts } = useRows<ShiftRow & Row>("shifts");
  const { rows: projects } = useRows<Row & { name?: string }>("projects");
  const { rows: onboarding } = useRows<
    Named & { satisfied?: boolean | null; submitted_at?: string | null; expires_on?: string | null }
  >("onboarding_items");
  const { rows: deliverables } = useRows<
    Named & { deliverable_state?: string | null; due_at?: string | null }
  >("deliverables");
  const { rows: shared } = useRows<
    Named & {
      record_kind?: string | null;
      record_state?: string | null;
      starts_at?: string | null;
      due_at?: string | null;
    }
  >("shared_records");
  const { rows: orders } = useRows<
    Row & {
      po_number?: number | string | null;
      project_name?: string | null;
      sent_at?: string | null;
    }
  >("purchase_orders");
  const { rows: incidents } = useRows<
    Named & {
      project_id?: string;
      incident_number?: number | string | null;
      occurred_at?: string | null;
    }
  >("incidents", (i) => i.project_id === projectId);
  const { rows: roster } = useRows<Row & { display_name?: string | null }>("kiosk_roster");
  const { rows: sops } = useRows<Named & { code?: string | null; body?: string | null }>("sops");
  const { rows: codes } = useRows<Row & { code?: string | null; label?: string | null }>(
    "emergency_codes",
  );
  const { rows: channels } = useRows<
    Row & { project_id?: string; channel_number?: number | string | null; name?: string | null }
  >("radio_channels", (c) => c.project_id === projectId);
  const { rows: zones } = useRows<Row & { code?: string | null; name?: string | null }>("zones");

  const docs = useMemo((): LocalSearchDoc[] => {
    if (!identity) return [];
    const allowed = (feature: Feature) => access(identity, feature, projectId).allowed;
    const me = {
      membershipId: identity.membershipId,
      engagementIds: operationalEngagements(identity, null).map((e) => e.id),
    };
    const projectName = new Map(projects.map((p) => [p.id, String(p.name ?? "")]));
    const text = (value: unknown) => (value === null || value === undefined ? "" : String(value));
    const out: LocalSearchDoc[] = [];
    for (const s of shifts) {
      if (!isMine(s, me) || s.shift_state === "Draft") continue;
      const zone = scheduleZone(s.time_zone, orgSettings);
      out.push({
        kind: "shift",
        id: s.id,
        title: roleTitle(s) || t("compass.schedule.myShifts"),
        body: projectName.get(s.project_id) ?? "",
        subtitle: t("compassSearch.when", {
          day: formatDay(s.starts_at, zone),
          time: t("compass.schedule.timeRange", {
            start: formatTime(s.starts_at, zone),
            end: formatTime(s.ends_at, zone),
          }),
        }),
        at: s.starts_at,
        href: "/schedule",
      });
    }
    for (const o of onboarding) {
      if (o.satisfied) continue;
      out.push({
        kind: "task",
        id: o.id,
        title: text(o.name),
        at: o.expires_on ?? null,
        href: "/onboarding",
      });
    }
    for (const d of deliverables) {
      if (d.deliverable_state === "Accepted") continue;
      out.push({
        kind: "task",
        id: d.id,
        title: text(d.title),
        at: d.due_at ?? null,
        href: "/deliverables",
      });
    }
    for (const r of shared) {
      out.push({
        kind: r.record_kind === "Task" ? "task" : "record",
        id: r.id,
        title: text(r.title),
        body: text(r.record_kind),
        at: r.due_at ?? r.starts_at ?? null,
        href: "/submittals",
      });
    }
    for (const p of orders) {
      out.push({
        kind: "record",
        id: p.id,
        title: t("compassSearch.purchaseOrder", { number: text(p.po_number) }),
        body: text(p.project_name),
        code: text(p.po_number),
        at: p.sent_at ?? null,
        href: "/purchase-orders",
      });
    }
    for (const i of incidents) {
      out.push({
        kind: "record",
        id: i.id,
        title: text(i.title),
        code: text(i.incident_number),
        at: i.occurred_at ?? null,
        href: "/incidents",
      });
    }
    const people = allowed("crew.board") ? "/crew" : "/workforce/directory";
    for (const p of roster) {
      if (!p.display_name) continue;
      out.push({ kind: "person", id: p.id, title: p.display_name, href: people });
    }
    for (const s of sops) {
      out.push({
        kind: "reference",
        id: s.id,
        title: text(s.title),
        body: text(s.body),
        code: text(s.code),
        href: "/reference/sops",
      });
    }
    for (const c of codes) {
      out.push({
        kind: "reference",
        id: c.id,
        title: text(c.label),
        code: text(c.code),
        href: "/reference/emergency-codes",
      });
    }
    for (const c of channels) {
      out.push({
        kind: "reference",
        id: c.id,
        title: text(c.name),
        code: text(c.channel_number),
        subtitle: t("compassSearch.channel", { number: text(c.channel_number) }),
        href: "/reference/radio-channels",
      });
    }
    for (const z of zones) {
      out.push({
        kind: "reference",
        id: z.id,
        title: text(z.name),
        code: text(z.code),
        href: "/reference/venue-maps",
      });
    }
    out.push(...actionDocs(allowed, (key) => t(`compassSearch.actions.${key}`)));
    return out;
  }, [
    identity,
    projectId,
    projects,
    shifts,
    onboarding,
    deliverables,
    shared,
    orders,
    incidents,
    roster,
    sops,
    codes,
    channels,
    zones,
    orgSettings,
    roleTitle,
    t,
  ]);

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
