import {
  configurePersonCalendarFeed,
  createPersonCalendarFeed,
  revokePersonCalendarFeed,
  rotatePersonCalendarFeed,
  type CalendarFeedSource,
} from "@xos/data/calendar-feeds";
import type { XosClient } from "@xos/data/client";
import { useCallback, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { useCompass } from "../../src/runtime/CompassProvider";
import {
  facts,
  IssuedLinkCard,
  useConfirmed,
  useMediumDate,
} from "../../src/screens/settings/ConnectionParts";
import { useMirror } from "../../src/screens/settings/hooks";
import { ConfirmSheet, OfflineNotice } from "../../src/screens/settings/parts";
import {
  CALENDAR_FEEDS_MIRROR,
  FEED_SOURCES,
  feedConfiguration,
  feedErrorKey,
  feedItems,
  issuedLink,
  readMyFeeds,
  shownSources,
  type FeedRow,
  type IssuedLink,
} from "../../src/settings/calendar-feeds";
import {
  Button,
  Card,
  InlineAlert,
  ListRow,
  Screen,
  Skeleton,
  Switch,
  Text,
  TextField,
  useTheme,
} from "../../src/ui";

const C = "gateway.settings.calendarFeeds";

type FeedChange = { readonly kind: "rotate" | "revoke"; readonly feed: FeedRow };

/**
 * Settings, Calendar Feeds (sitemap settings.calendar-feeds; Section 4.5.6 item 12, A84, ADR 0040, ADR 0072): the
 * person's own feeds across every org they work with, as Gateway manages them. A new feed or a new link is shown
 * once, to copy or share and to open in the calendar app; the list shows offline, and every change needs a
 * connection. A feed is added or edited with a name and what it shows, cues included (B7, ADR 0146).
 */
export default function CalendarFeedsScreen(): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  const { client, network, config } = useCompass();
  const db = client as unknown as XosClient;
  const date = useMediumDate();
  const online = network.isConnected;
  const read = useCallback(() => readMyFeeds(client), [client]);
  const feeds = useMirror<FeedRow>(CALENDAR_FEEDS_MIRROR, read);
  // The link lives here only, never on the device: the token is shown once.
  const [link, setLink] = useState<IssuedLink | null>(null);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const change = useConfirmed<FeedChange>();
  // The name and content the next Add or Save sends; Edit loads a feed's into them.
  const [editing, setEditing] = useState<FeedRow | null>(null);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<CalendarFeedSource>>(
    () => new Set(shownSources({ sources: null })),
  );
  const toggle = (source: CalendarFeedSource, on: boolean) =>
    setPicked((current) => {
      const next = new Set(current);
      if (on) next.add(source);
      else next.delete(source);
      return next;
    });
  const reset = () => {
    setEditing(null);
    setName("");
    setPicked(new Set(shownSources({ sources: null })));
  };
  const edit = (feed: FeedRow) => {
    setEditing(feed);
    setName(feed.name ?? "");
    setPicked(new Set(shownSources(feed)));
  };

  const add = async () => {
    setAdding(true);
    setNotice(null);
    const configuration = feedConfiguration(name, picked);
    const result = editing
      ? await configurePersonCalendarFeed(db, editing.id, configuration)
      : await createPersonCalendarFeed(db, configuration);
    setAdding(false);
    if (!result.ok) {
      setNotice({ tone: "danger", text: t(feedErrorKey(result.error)) });
      return;
    }
    if (result.data) setLink(issuedLink(config.gatewayUrl, result.data.id, result.data.token));
    else setNotice({ tone: "success", text: t("compassSettings.common.saved") });
    reset();
    feeds.reload();
  };

  const apply = async ({ kind, feed }: FeedChange): Promise<string | null> => {
    if (kind === "rotate") {
      const result = await rotatePersonCalendarFeed(db, feed.id);
      if (!result.ok) return t(feedErrorKey(result.error));
      setLink(issuedLink(config.gatewayUrl, feed.id, result.data.token));
      setNotice({ tone: "success", text: t("compassSettings.calendarFeeds.rotated") });
    } else {
      const result = await revokePersonCalendarFeed(db, feed.id);
      if (!result.ok) return t(feedErrorKey(result.error));
      if (link?.feedId === feed.id) setLink(null);
      setNotice({ tone: "success", text: t("compassSettings.calendarFeeds.revoked") });
    }
    feeds.reload();
    return null;
  };

  const target = change.target;
  const items = feedItems(feeds.rows);
  return (
    <Screen testID="settings-feeds" title={t("nav.settings.personal.calendarFeeds")}>
      <Text tone="secondary">{t("gateway.settings.leads.calendarFeeds")}</Text>
      <Card>
        <Text variant="text13" tone="secondary">
          {t(`${C}.description`)}
        </Text>
        <Text variant="text13" tone="tertiary">
          {t(`${C}.secret`)}
        </Text>
      </Card>
      {!online ? <OfflineNotice kind="needs" testID="settings-feeds-offline" /> : null}
      {notice ? (
        <InlineAlert
          testID={notice.tone === "success" ? "settings-feeds-done" : "settings-feeds-error"}
          tone={notice.tone}
          message={notice.text}
        />
      ) : null}
      {link ? <IssuedLinkCard link={link} /> : null}
      <Card testID="settings-feeds-list" title={t(`${C}.listLabel`)}>
        {!feeds.ready ? (
          feeds.notLoaded ? (
            <OfflineNotice kind="first" testID="settings-feeds-first" />
          ) : feeds.failed ? (
            <InlineAlert tone="danger" message={t("compassSettings.common.loadFailed")} />
          ) : (
            <Skeleton testID="settings-feeds-loading" lines={2} />
          )
        ) : items.length === 0 ? (
          <Text testID="settings-feeds-empty" tone="secondary">
            {t(`${C}.none`)}
          </Text>
        ) : (
          items.map((feed) => (
            <View key={feed.id} testID="settings-feed" style={{ gap: theme.space["4"] }}>
              <ListRow
                icon="calendar"
                title={feed.name ?? t(`${C}.feedName`)}
                subtitle={facts(
                  t(`${C}.filterSummary`, {
                    sources: shownSources(feed)
                      .map((s) => t(`${C}.sources.${s.toLowerCase()}`))
                      .join(", "),
                  }),
                  t(`${C}.hint`, { hint: feed.tokenHint }),
                  feed.rotatedAt
                    ? t(`${C}.rotated`, { date: date(feed.rotatedAt) })
                    : t(`${C}.created`, { date: date(feed.createdAt) }),
                  feed.lastAccessedAt
                    ? t(`${C}.lastFetched`, { date: date(feed.lastAccessedAt) })
                    : t(`${C}.neverFetched`),
                )}
              />
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space["8"] }}>
                <Button
                  testID="settings-feed-edit"
                  variant="ghost"
                  icon="pencil"
                  label={t(`${C}.edit`)}
                  disabled={!online}
                  onPress={() => edit(feed)}
                />
                <Button
                  testID="settings-feed-rotate"
                  variant="secondary"
                  icon="refresh-cw"
                  label={t(`${C}.rotate`)}
                  disabled={!online}
                  onPress={() => change.ask({ kind: "rotate", feed })}
                />
                <Button
                  testID="settings-feed-revoke"
                  variant="ghost"
                  icon="trash-2"
                  label={t(`${C}.revoke`)}
                  disabled={!online}
                  onPress={() => change.ask({ kind: "revoke", feed })}
                />
              </View>
            </View>
          ))
        )}
      </Card>
      <Card testID="settings-feeds-form" title={editing ? t(`${C}.editTitle`) : t(`${C}.add`)}>
        <TextField
          testID="settings-feeds-name"
          label={t(`${C}.nameLabel`)}
          help={t(`${C}.nameHelp`)}
          value={name}
          onChangeText={setName}
          disabled={!online}
        />
        <Text variant="text13" tone="secondary">
          {t(`${C}.contentLabel`)}
        </Text>
        {FEED_SOURCES.map((source) => (
          <Switch
            key={source}
            testID={`settings-feeds-source-${source.toLowerCase()}`}
            label={t(`${C}.sources.${source.toLowerCase()}`)}
            value={picked.has(source)}
            onChange={(on) => toggle(source, on)}
            disabled={!online}
          />
        ))}
        <Button
          testID="settings-feeds-add"
          block
          label={editing ? t(`${C}.save`) : t(`${C}.add`)}
          loading={adding}
          disabled={!online}
          onPress={() => void add()}
        />
        {editing ? (
          <Button
            testID="settings-feeds-cancel"
            block
            variant="ghost"
            label={t("compassSettings.calendarFeeds.cancelEdit")}
            onPress={reset}
          />
        ) : null}
      </Card>
      <ConfirmSheet
        testID="settings-feed-confirm"
        open={target !== null}
        title={
          target
            ? t(target.kind === "rotate" ? `${C}.rotateLabel` : `${C}.revokeLabel`, {
                hint: target.feed.tokenHint,
              })
            : ""
        }
        sentence={
          target ? t(target.kind === "rotate" ? `${C}.rotateConfirm` : `${C}.revokeConfirm`) : ""
        }
        confirmLabel={target ? t(target.kind === "rotate" ? `${C}.rotate` : `${C}.revoke`) : ""}
        danger={target?.kind === "revoke"}
        busy={change.busy}
        error={change.error}
        onConfirm={() => void change.confirm(apply)}
        onClose={change.close}
      />
    </Screen>
  );
}
