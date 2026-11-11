/**
 * Pieces the Payout and Tax, Calendar Feeds, Connected Apps and Developer screens share (ADR 0072): dates in the
 * person's language, a step that opens Gateway and says why, a change confirmed in a sheet that needs the server's
 * answer, and a calendar feed link shown once.
 */
import * as Linking from "expo-linking";
import { useCallback, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Platform, Share, View } from "react-native";
import type { IssuedLink } from "../../settings/calendar-feeds";
import { Button, Card, Icon, ListRow, Text, useTheme } from "../../ui";

/** A date in the person's language, medium length ("Oct 24, 2026", "24 oct 2026"). */
export function useMediumDate(): (iso: string) => string {
  const { i18n } = useTranslation();
  return useCallback(
    (iso: string) =>
      new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }).format(new Date(iso)),
    [i18n.language],
  );
}

/** The facts of a row joined for its subtitle, leaving out the ones it does not have. */
export function facts(...parts: readonly (string | null | false | undefined)[]): string {
  return parts.filter((p): p is string => typeof p === "string" && p !== "").join(" · ");
}

/**
 * A step Compass leaves to Gateway, deliberately: the row names the step, says why it opens Gateway, and opens the
 * page there.
 */
export function GatewayStep({
  title,
  reason,
  url,
  icon,
  testID,
}: {
  readonly title: string;
  readonly reason: string;
  readonly url: string;
  readonly icon: string;
  readonly testID: string;
}): ReactElement {
  return (
    <ListRow
      testID={testID}
      icon={icon}
      title={title}
      subtitle={reason}
      trailing={<Icon name="external-link" size={20} tone="secondary" />}
      onPress={() => void Linking.openURL(url)}
    />
  );
}

export interface Confirmed<T> {
  /** The item the sheet asks about, or null while it is closed. */
  readonly target: T | null;
  readonly busy: boolean;
  /** Why the last attempt failed, in the person's language, or null. */
  readonly error: string | null;
  readonly ask: (item: T) => void;
  readonly close: () => void;
  /** Runs the change for the item; it returns the sentence of a failure, or null when the change went through. */
  readonly confirm: (change: (item: T) => Promise<string | null>) => Promise<void>;
}

/** A change that needs the server's answer, asked in a confirmation sheet and kept open on a failure. */
export function useConfirmed<T>(): Confirmed<T> {
  const [target, setTarget] = useState<T | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ask = useCallback((item: T) => {
    setError(null);
    setTarget(item);
  }, []);
  const close = useCallback(() => {
    setTarget(null);
    setError(null);
  }, []);
  const confirm = useCallback(
    async (change: (item: T) => Promise<string | null>) => {
      if (target === null) return;
      setBusy(true);
      setError(null);
      const failure = await change(target).catch((e: unknown) =>
        e instanceof Error ? e.message : String(e),
      );
      setBusy(false);
      if (failure === null) setTarget(null);
      else setError(failure);
    },
    [target],
  );
  return { target, busy, error, ask, close, confirm };
}

/**
 * A calendar feed link just issued, shown once: copy or share it through the system share sheet (Copy is the first
 * of its actions on iOS and Android), or open it in the phone's calendar app with the webcal link.
 */
export function IssuedLinkCard({ link }: { readonly link: IssuedLink }): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  const C = "gateway.settings.calendarFeeds";
  return (
    <Card testID="settings-feeds-link" title={t(`${C}.linkTitle`)}>
      <Text variant="text13" tone="secondary">
        {t("compassSettings.calendarFeeds.linkHelp")}
      </Text>
      <Text testID="settings-feeds-link-url" variant="mono13">
        {link.url}
      </Text>
      <View style={{ gap: theme.space["8"] }}>
        <Button
          testID="settings-feeds-link-share"
          block
          label={t("compassSettings.calendarFeeds.share")}
          // iOS shares a URL as a link (Copy copies it); Android shares text.
          onPress={() =>
            void Share.share(
              Platform.OS === "ios"
                ? { url: link.url }
                : { message: link.url, title: t(`${C}.linkLabel`) },
            )
          }
        />
        <Button
          testID="settings-feeds-link-open"
          variant="secondary"
          icon="calendar"
          block
          label={t(`${C}.openInCalendar`)}
          onPress={() => void Linking.openURL(link.webcal)}
        />
      </View>
    </Card>
  );
}
