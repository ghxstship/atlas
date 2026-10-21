/**
 * Platform system banners in Compass (A90, Section 4.10): maintenance, incidents and plan notices the operator
 * console publishes. Read from api_public.active_system_banners when the app starts and when it returns to the
 * foreground, at most once a minute, so a banner never holds up a screen; offline, the last answer stands. A person
 * hides a dismissible banner on this device only.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  addDismissed,
  BANNER_CACHE_SECONDS,
  bannerText,
  bannerTone,
  listActiveSystemBanners,
  parseDismissed,
  visibleBanners,
  type SystemBanner,
} from "@xos/data/system-banners";
import * as Linking from "expo-linking";
import * as SecureStore from "expo-secure-store";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { AppState, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Banner, useTheme } from "../ui";

const DISMISSED_KEY = "xos.compass.dismissed-banners";

export function SystemBanners({ client }: { client: SupabaseClient | null }): ReactElement | null {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [banners, setBanners] = useState<SystemBanner[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const lastRead = useRef(0);

  const refresh = useCallback(async () => {
    if (!client || Date.now() - lastRead.current < BANNER_CACHE_SECONDS * 1000) return;
    lastRead.current = Date.now();
    const [result, stored] = await Promise.all([
      listActiveSystemBanners(client, "compass"),
      SecureStore.getItemAsync(DISMISSED_KEY),
    ]);
    setDismissed(parseDismissed(stored));
    // Unreachable server: the last answer stands until the next foreground.
    if (result.ok) setBanners(result.data);
  }, [client]);

  useEffect(() => {
    void refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  const shown = visibleBanners(banners, dismissed);
  if (shown.length === 0) return null;
  const dismiss = (id: string) => {
    const next = addDismissed(JSON.stringify(dismissed), id);
    setDismissed(parseDismissed(next));
    void SecureStore.setItemAsync(DISMISSED_KEY, next);
  };
  return (
    <View
      testID="system-banners"
      style={{
        gap: theme.space["8"],
        paddingHorizontal: theme.space["16"],
        paddingTop: insets.top + theme.space["8"],
      }}
    >
      {shown.map((banner) => (
        <Banner
          key={banner.id}
          testID={`system-banner-${banner.id}`}
          tone={bannerTone(banner.severity)}
          message={bannerText(banner, i18n.language)}
          {...(banner.linkUrl
            ? {
                actionLabel: t("compass.systemBanner.details"),
                onAction: () => void Linking.openURL(banner.linkUrl ?? ""),
              }
            : {})}
          {...(banner.dismissible
            ? {
                onDismiss: () => dismiss(banner.id),
                dismissLabel: t("compass.systemBanner.dismiss"),
              }
            : {})}
        />
      ))}
    </View>
  );
}
