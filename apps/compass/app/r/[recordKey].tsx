import * as Linking from "expo-linking";
import { useLocalSearchParams } from "expo-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { isInternal } from "@xos/sync";
import { useCompass } from "../../src/runtime/CompassProvider";
import { Button, Screen, Text } from "../../src/ui";

/**
 * Deep links compass://r/{recordKey} (Section 4.5.7). Records open on the web shell that owns them until
 * Compass has a record view: Atlas for internal users, Gateway for external users.
 */
export default function RecordLink(): ReactElement {
  const { t } = useTranslation();
  const { recordKey } = useLocalSearchParams<{ recordKey: string }>();
  const { resolved, config } = useCompass();
  const internal = resolved ? isInternal(resolved.identity.audience) : true;
  const url = `${internal ? config.atlasUrl : config.gatewayUrl}/r/${encodeURIComponent(recordKey ?? "")}`;
  return (
    <Screen testID="record-link" title={recordKey ?? ""}>
      <Text tone="secondary">{t("compass.record.sentence", { key: recordKey ?? "" })}</Text>
      <Button
        testID="record-open"
        label={t(internal ? "compass.common.openAtlas" : "compass.common.openGateway")}
        onPress={() => void Linking.openURL(url)}
      />
    </Screen>
  );
}
