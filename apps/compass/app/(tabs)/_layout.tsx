import { Tabs, useRouter } from "expo-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { tabBar } from "../../src/domain/access";
import { useCompass } from "../../src/runtime/CompassProvider";
import { TabBar } from "../../src/ui";
import { NativeHeaderContext } from "../../src/ui/layout";

/** Tab icons by sitemap tab id. */
const TAB_ICONS: Readonly<Record<string, string>> = {
  today: "sun",
  schedule: "calendar",
  scan: "scan-line",
  inbox: "inbox",
  more: "menu",
  crew: "users",
};

/**
 * Five tabs for everyone and Crew for Field Supervisors (Section 4.5.7), from the generated sitemap
 * navigation. The Scan tab is the raised center action.
 */
export default function TabsLayout(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const { resolved, status } = useCompass();
  const tabs = resolved ? tabBar(resolved.identity.audience) : [];
  const ids = new Set(tabs.map((tab) => tab.id));
  // Tabs hide the stack header, so each tab draws its own title (finding A59-031).
  return (
    <NativeHeaderContext.Provider value={false}>
      <Tabs
        screenOptions={{ headerShown: false }}
        tabBar={({ state }) => (
          <TabBar
            testID="tab-bar"
            label={t("compass.app.tabBar")}
            active={state.routes[state.index]?.name ?? "today"}
            items={tabs.map((tab) => ({
              key: tab.id,
              label: t(tab.label),
              icon: TAB_ICONS[tab.id] ?? "menu",
              ...(tab.id === "more" && status && status.conflicts > 0
                ? { badge: status.conflicts }
                : {}),
            }))}
            onSelect={(key) => router.navigate(`/${key}`)}
            center={{
              label: t("nav.compass.tabs.scan"),
              icon: "scan-line",
              onPress: () => router.navigate("/scan"),
            }}
          />
        )}
      >
        <Tabs.Screen name="today" />
        <Tabs.Screen name="schedule" />
        <Tabs.Screen name="scan" />
        <Tabs.Screen name="inbox" />
        <Tabs.Screen name="more" />
        <Tabs.Screen name="crew" options={{ href: ids.has("crew") ? "/crew" : null }} />
      </Tabs>
    </NativeHeaderContext.Provider>
  );
}
