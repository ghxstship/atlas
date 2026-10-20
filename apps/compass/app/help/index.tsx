import { articlesForNode, helpLocale, isSpecificTo, searchArticles, type Article } from "@xos/help";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { articlesForAudience, helpNodeFor, helpNodesFor } from "../../src/domain/help";
import { COMPASS_HELP } from "../../src/help/content.generated";
import { lastHelpScreen } from "../../src/runtime/help";
import { useCompass } from "../../src/runtime/CompassProvider";
import { Button, Card, ListRow, Screen, Text, TextField } from "../../src/ui";

/**
 * Help (Section 11.16), opened from More or Settings: the articles for the screen the person was
 * using, the general articles, every article for their role, search, and Contact Support. Articles
 * ship inside the app, so Help reads the same offline.
 */
export default function HelpScreen(): ReactElement {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const { resolved } = useCompass();
  const params = useLocalSearchParams<{ screen?: string }>();
  const [query, setQuery] = useState("");
  const articles = COMPASS_HELP.articles[helpLocale(i18n.language)];
  const visible = resolved
    ? articlesForAudience(articles, helpNodesFor(resolved.identity.audience))
    : articles;
  const screen = params.screen ?? lastHelpScreen();
  const node = screen ? helpNodeFor(screen) : null;
  const forPage = articlesForNode(visible, node);
  const specific = forPage.filter((a) => node !== null && isSpecificTo(a, node));
  const general = forPage.filter((a) => !specific.includes(a));
  const rest = visible
    .filter((a) => !forPage.includes(a))
    .sort((a, b) => a.title.localeCompare(b.title, i18n.language));
  const results = searchArticles(visible, query);
  const rows = (list: readonly Article[], prefix: string) =>
    list.map((a) => (
      <ListRow
        key={a.slug}
        testID={`${prefix}-${a.slug}`}
        title={a.title}
        subtitle={a.summary}
        onPress={() => router.push(`/help/${a.slug}` as Href)}
      />
    ));
  return (
    <Screen testID="help" title={t("compass.help.title")}>
      <TextField
        testID="help-search"
        label={t("compass.help.search")}
        value={query}
        onChangeText={setQuery}
      />
      {query.trim() !== "" ? (
        <Card title={t("compass.help.results", { query: query.trim() })}>
          {results.length > 0 ? (
            rows(results, "help-result")
          ) : (
            <Text tone="secondary">{t("compass.help.searchEmpty", { query: query.trim() })}</Text>
          )}
        </Card>
      ) : (
        <>
          {specific.length > 0 ? (
            <Card testID="help-for-screen" title={t("compass.help.forScreen")}>
              {rows(specific, "help-article")}
            </Card>
          ) : null}
          <Card testID="help-general" title={t("compass.help.general")}>
            {rows(general, "help-article")}
          </Card>
          <Card testID="help-all" title={t("compass.help.all")}>
            {rows(rest, "help-article")}
          </Card>
        </>
      )}
      <Button
        testID="help-contact"
        variant="secondary"
        icon="circle-help"
        block
        label={t("compass.help.contact.open")}
        onPress={() => router.push("/help/contact" as Href)}
      />
      <Text variant="text13" tone="tertiary">
        {t("compass.help.offline")}
      </Text>
    </Screen>
  );
}
