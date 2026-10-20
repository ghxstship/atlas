import { isInternal } from "@xos/sync";
import * as Linking from "expo-linking";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { certificationsUrl } from "../src/domain/access";
import { useCompass } from "../src/runtime/CompassProvider";
import { Button, Card, ListRow, Screen, Text } from "../src/ui";

/** The person, their role in Compass and, for external users, their engagements across orgs. */
export default function ProfileScreen(): ReactElement {
  const { t } = useTranslation();
  const { resolved, config } = useCompass();
  const identity = resolved?.identity;
  const internal = identity ? isInternal(identity.audience) : false;
  return (
    <Screen testID="profile" title={t("compass.profile.title")}>
      <Text variant="heading24" heading>
        {identity?.displayName ?? ""}
      </Text>
      <Card title={t("compass.profile.role")}>
        <Text testID="profile-audience">
          {identity ? t(`compass.audience.${identity.audience}`) : ""}
        </Text>
      </Card>
      {identity && identity.engagements.length > 0 ? (
        <Card title={t("compass.profile.engagements")}>
          {identity.engagements.map((e) => (
            <ListRow
              key={e.id}
              icon="file-text"
              title={e.projectName}
              subtitle={`${e.orgName} · ${e.state}`}
            />
          ))}
        </Card>
      ) : null}
      {identity ? (
        <Card title={t("compass.profile.certificationsTitle")}>
          <Text tone="secondary">
            {t(
              internal
                ? "compass.profile.certificationsAtlas"
                : "compass.profile.certificationsGateway",
            )}
          </Text>
          <Button
            testID="profile-certifications"
            variant="secondary"
            icon="external-link"
            label={t(internal ? "compass.common.openAtlas" : "compass.common.openGateway")}
            onPress={() => void Linking.openURL(certificationsUrl(identity.audience, config))}
          />
        </Card>
      ) : null}
    </Screen>
  );
}
