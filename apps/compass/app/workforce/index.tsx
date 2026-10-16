import { useRouter, type Href } from "expo-router";
import type { ReactElement } from "react";
import { useCompass } from "../../src/runtime/CompassProvider";
import { ProjectPicker, SyncBanner } from "../../src/screens/common";
import { Card, ListRow, Screen, Text } from "../../src/ui";
import { useT, WorkforceGate } from "../../src/workforce/kit";
import { hubEntries } from "../../src/workforce/routes";

/** More > Workforce: the Workforce Suite screens (Section 4.9), mounted from workforceScreens. */
function Hub(): ReactElement {
  const t = useT();
  const router = useRouter();
  const { resolved } = useCompass();
  const { crew, siteOps } = hubEntries(resolved?.identity.capabilities ?? []);
  const rows = (list: typeof crew) =>
    list.map((e) => (
      <ListRow
        key={e.name}
        testID={`workforce-${e.label}`}
        icon={e.icon}
        title={t(`workforce.compass.hub.screens.${e.label}`)}
        onPress={() => router.push(e.route as Href)}
      />
    ));
  return (
    <Screen testID="workforce" title={t("workforce.compass.hub.title")}>
      <ProjectPicker />
      <SyncBanner />
      <Text variant="heading16" heading>
        {t("workforce.compass.hub.crew")}
      </Text>
      <Card>{rows(crew)}</Card>
      {siteOps.length > 0 ? (
        <>
          <Text variant="heading16" heading>
            {t("workforce.compass.hub.siteOps")}
          </Text>
          <Card>{rows(siteOps)}</Card>
        </>
      ) : null}
    </Screen>
  );
}

export default function WorkforceHub(): ReactElement {
  return (
    <WorkforceGate>
      <Hub />
    </WorkforceGate>
  );
}
