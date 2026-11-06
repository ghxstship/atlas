import * as Linking from "expo-linking";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { useCompass } from "../runtime/CompassProvider";
import { Button, Card, InlineAlert, Text, useTheme } from "../ui";

/**
 * The first-use AI disclosure (Apple guideline 5.1.2(i), ADR 0156): shown before anything goes to the AI provider, it says
 * who receives what and records the person's choice (app.record_ai_choice). Declining turns AI features off for the
 * person, on the server too. Both answers need the server, so it says so when it cannot reach it.
 */
export function AiDisclosure({ testID = "ai-disclosure" }: { readonly testID?: string }): ReactElement {
  const { t } = useTranslation();
  const theme = useTheme();
  const { aiChoice, chooseAi, config } = useCompass();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const choose = async (choice: "Allowed" | "Declined") => {
    setBusy(true);
    setFailed(false);
    const done = await chooseAi(choice);
    setBusy(false);
    setFailed(!done);
  };
  return (
    <Card testID={testID} title={t("compass.aiDisclosure.title")}>
      <View style={{ gap: theme.space["8"] }}>
        <Text>{t("compass.aiDisclosure.provider")}</Text>
        <Text tone="secondary">{t("compass.aiDisclosure.sent")}</Text>
        <Text tone="secondary">{t("compass.aiDisclosure.notSent")}</Text>
        <Text variant="text13" tone="tertiary">
          {t("compass.aiDisclosure.change")}
        </Text>
        <Button
          testID={`${testID}-notice`}
          variant="ghost"
          icon="external-link"
          label={t("compass.aiDisclosure.notice")}
          onPress={() => void Linking.openURL(`${config.atlasUrl}/legal/ai-features-notice`)}
        />
        {failed ? (
          <InlineAlert
            testID={`${testID}-failed`}
            tone="danger"
            message={t("compass.aiDisclosure.failed")}
          />
        ) : null}
        <Button
          testID={`${testID}-allow`}
          block
          loading={busy}
          disabled={busy}
          label={t("compass.aiDisclosure.allow")}
          onPress={() => void choose("Allowed")}
        />
        {aiChoice === "Declined" ? null : (
          <Button
            testID={`${testID}-decline`}
            variant="secondary"
            block
            disabled={busy}
            label={t("compass.aiDisclosure.decline")}
            onPress={() => void choose("Declined")}
          />
        )}
      </View>
    </Card>
  );
}
