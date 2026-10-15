import * as Linking from "expo-linking";
import { useLocalSearchParams } from "expo-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { isInternal } from "@xos/sync";
import { moreMenu } from "../../src/domain/access";
import { useCompass } from "../../src/runtime/CompassProvider";
import { DenialNotice } from "../../src/screens/common";
import { Button, Screen, Text } from "../../src/ui";

/**
 * More entries whose module screens are not native to Compass yet (timesheets, per diem, purchase orders,
 * logistics, expenses and the rest). The page names where the work lives today and opens it there
 * (Section 11.10 item 13: continue on another device).
 */
export default function PendingPage(): ReactElement {
  const { t } = useTranslation();
  const { page } = useLocalSearchParams<{ page: string }>();
  const { resolved, config } = useCompass();
  const audience = resolved?.identity.audience;
  const entry = audience ? moreMenu(audience).find((m) => m.id === page) : undefined;
  if (!entry || !audience)
    return (
      <Screen>
        <DenialNotice reason="role" />
      </Screen>
    );
  const name = t(entry.label);
  const internal = isInternal(audience);
  const url = `${internal ? config.atlasUrl : config.gatewayUrl}${entry.route}`;
  return (
    <Screen testID={`pending-${entry.id}`} title={name}>
      <Text variant="heading20" heading>
        {internal
          ? t("compass.more.pendingAtlasTitle", { page: name })
          : t("compass.more.pendingTitle", { page: name })}
      </Text>
      <Text tone="secondary">
        {internal
          ? t("compass.more.pendingAtlas", { page: name })
          : t("compass.more.pending", { page: name })}
      </Text>
      <Button
        testID="pending-open"
        label={t(internal ? "compass.common.openAtlas" : "compass.common.openGateway")}
        onPress={() => void Linking.openURL(url)}
      />
    </Screen>
  );
}
