import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useCompass } from "../src/runtime/CompassProvider";
import { Card, ListRow, Screen, Text } from "../src/ui";

/** The person, their role in Compass and, for external users, their engagements across orgs. */
export default function ProfileScreen(): ReactElement {
  const { t } = useTranslation();
  const { resolved } = useCompass();
  const identity = resolved?.identity;
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
      <Text tone="tertiary">{t("compass.profile.certifications")}</Text>
    </Screen>
  );
}
