import { helpLocale } from "@xos/help";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { COMPASS_HELP } from "../../src/help/content.generated";
import { HelpArticleBody } from "../../src/screens/HelpArticle";
import { Button, EmptyState, Screen, Text } from "../../src/ui";

/** One help article, read from the copy that ships with the app (Section 11.16). */
export default function HelpArticleScreen(): ReactElement {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const article = COMPASS_HELP.articles[helpLocale(i18n.language)].find((a) => a.slug === slug);
  if (!article) {
    return (
      <Screen testID="help-article-missing" title={t("compass.help.title")}>
        <EmptyState
          icon="circle-help"
          sentence={t("compass.help.missing")}
          actionLabel={t("compass.help.back")}
          onAction={() => router.replace("/help" as Href)}
        />
      </Screen>
    );
  }
  return (
    <Screen testID={`help-article-${article.slug}`} title={article.title}>
      <Text tone="secondary">{article.summary}</Text>
      <HelpArticleBody blocks={article.body} />
      <Button
        testID="help-article-contact"
        variant="ghost"
        icon="circle-help"
        label={t("compass.help.contact.open")}
        onPress={() => router.push("/help/contact" as Href)}
      />
    </Screen>
  );
}
