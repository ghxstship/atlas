import * as Linking from "expo-linking";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { webFallbackUrl } from "../../src/domain/handoff";
import { useCompass } from "../../src/runtime/CompassProvider";
import { Button, Screen, Text } from "../../src/ui";

/**
 * An engagement handed off from Gateway (compass://e/{engagementKey}, ADR 0030). Compass has no
 * engagement record screen, so the engagement opens on Gateway; its shifts are on the schedule here.
 */
export default function EngagementHandoff(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const { engagementKey } = useLocalSearchParams<{ engagementKey: string }>();
  const { config } = useCompass();
  const key = engagementKey ?? "";
  const url = webFallbackUrl({ kind: "engagement", engagementKey: key }, config);
  return (
    <Screen testID="engagement-link" title={key}>
      <Text tone="secondary">{t("compass.record.engagement", { key })}</Text>
      <Button
        testID="engagement-open"
        label={t("compass.common.openGateway")}
        icon="file-text"
        onPress={() => void Linking.openURL(url)}
      />
      <Button
        testID="engagement-schedule"
        variant="secondary"
        label={t("compass.record.open.schedule")}
        icon="calendar"
        onPress={() => router.push("/schedule" as never)}
      />
    </Screen>
  );
}
