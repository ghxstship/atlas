import { COMPASS_AURORA_ENTRY } from "@xos/ai/conversation";
import { isInternal } from "@xos/sync";
import * as Linking from "expo-linking";
import { useRouter, type Href } from "expo-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { elsewhereLink, moreSections } from "../../src/domain/access";
import { useCompass } from "../../src/runtime/CompassProvider";
import { ProjectPicker, SyncBanner, useAllowed } from "../../src/screens/common";
import { Badge, Card, ListRow, Screen } from "../../src/ui";

/** Icons by More menu id. */
const ICONS: Readonly<Record<string, string>> = {
  incidents: "shield-alert",
  inspections: "clipboard-check",
  logistics: "package",
  show: "clapperboard",
  "run-of-show": "clapperboard",
  reference: "book-open",
  "offline-queue": "refresh-cw",
  profile: "user",
  settings: "settings",
};

/**
 * The More menu in the sitemap's order for the person's role (Section 4.5.7). Compass's own screens
 * are listed; the entries it does not render yet (timesheets, per diem, purchase orders, expenses
 * and the rest) are named on one row that opens Gateway or Atlas directly, instead of one "this is
 * in Gateway" page per entry (finding A59-026).
 */
export default function MoreScreen(): ReactElement {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const { resolved, status, config } = useCompass();
  const canKiosk = useAllowed("kiosk.operate");
  const audience = resolved?.identity.audience;
  const { native, elsewhere } = audience ? moreSections(audience) : { native: [], elsewhere: [] };
  const link = audience ? elsewhereLink(audience, config) : null;
  const labels = elsewhere.map((m) => t(m.label));
  const names =
    typeof Intl.ListFormat === "function"
      ? new Intl.ListFormat(i18n.language, { type: "conjunction" }).format(labels)
      : labels.join(", ");
  return (
    <Screen testID="more" title={t("compass.more.title")}>
      <ProjectPicker />
      <SyncBanner />
      <Card>
        {native.map((item) => (
          <ListRow
            key={item.id}
            testID={`more-${item.id}`}
            icon={ICONS[item.id] ?? "chevron-right"}
            title={t(item.label)}
            trailing={
              item.id === "offline-queue" && status ? (
                <Badge count={status.queued} tone={status.conflicts > 0 ? "danger" : "neutral"} />
              ) : undefined
            }
            onPress={() => router.push(item.route as Href)}
          />
        ))}
        {audience && isInternal(audience) ? (
          <ListRow
            testID="more-workforce"
            icon="users"
            title={t("workforce.compass.hub.title")}
            onPress={() => router.push("/workforce" as Href)}
          />
        ) : null}
        {audience && isInternal(audience) ? (
          <ListRow
            testID={`more-${COMPASS_AURORA_ENTRY.id}`}
            icon="sparkles"
            title={t(COMPASS_AURORA_ENTRY.labelKey)}
            subtitle={t(COMPASS_AURORA_ENTRY.descriptionKey)}
            onPress={() => router.push(COMPASS_AURORA_ENTRY.route as Href)}
          />
        ) : null}
        {canKiosk ? (
          <ListRow
            testID="more-kiosk"
            icon="tablet"
            title={t("compass.settings.kiosk")}
            subtitle={t("compass.settings.kioskHelp")}
            onPress={() => router.push("/kiosk")}
          />
        ) : null}
        <ListRow
          testID="more-help"
          icon="circle-help"
          title={t("compass.help.entry")}
          subtitle={t("compass.help.entryHelp")}
          onPress={() => router.push("/help" as Href)}
        />
      </Card>
      {link && elsewhere.length > 0 ? (
        <Card title={t(link.app === "atlas" ? "compass.more.inAtlas" : "compass.more.inGateway")}>
          <ListRow
            testID={`more-open-${link.app}`}
            icon="external-link"
            title={t(
              link.app === "atlas" ? "compass.common.openAtlas" : "compass.common.openGateway",
            )}
            subtitle={names}
            onPress={() => void Linking.openURL(link.url)}
          />
        </Card>
      ) : null}
    </Screen>
  );
}
