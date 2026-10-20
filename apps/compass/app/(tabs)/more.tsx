import { COMPASS_AURORA_ENTRY } from "@xos/ai/conversation";
import { isInternal } from "@xos/sync";
import { useRouter, type Href } from "expo-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { moreMenu } from "../../src/domain/access";
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
  expenses: "file-text",
  reference: "book-open",
  "offline-queue": "refresh-cw",
  profile: "user",
  settings: "settings",
};

/** Routes Compass renders itself; every other More entry opens the pending-page state. */
const NATIVE = new Set([
  "incidents",
  "inspections",
  "logistics",
  "show",
  "run-of-show",
  "reference",
  "offline-queue",
  "profile",
  "settings",
]);

/** The More menu in the sitemap's order for the person's role (Section 4.5.7). */
export default function MoreScreen(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const { resolved, status } = useCompass();
  const canKiosk = useAllowed("kiosk.operate");
  const items = resolved ? moreMenu(resolved.identity.audience) : [];
  return (
    <Screen testID="more" title={t("compass.more.title")}>
      <ProjectPicker />
      <SyncBanner />
      <Card>
        {items.map((item) => (
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
            onPress={() =>
              router.push((NATIVE.has(item.id) ? item.route : `/pending/${item.id}`) as Href)
            }
          />
        ))}
        {resolved && isInternal(resolved.identity.audience) ? (
          <ListRow
            testID="more-workforce"
            icon="users"
            title={t("workforce.compass.hub.title")}
            onPress={() => router.push("/workforce" as Href)}
          />
        ) : null}
        {resolved && isInternal(resolved.identity.audience) ? (
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
    </Screen>
  );
}
