import { useLocalSearchParams } from "expo-router";
import { StatusBar } from "expo-status-bar";
import type { ReactElement } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GalleryScreen, galleryPages, type GalleryTheme } from "@xos/ui-native/gallery";

/**
 * The component gallery (A141, Section 11.4): every @xos/ui-native component in its main states, one
 * page at a time, for the Maestro snapshots in .maestro/flows/gallery-*.yaml. Opened as
 * compass://dev/gallery?theme=dark&page=1; a page past the last shows the end marker that stops the
 * flows. Gallery builds only (EXPO_PUBLIC_XOS_GALLERY=1): metro.config.js leaves this folder out of
 * every other build, app.config.ts refuses the switch in EAS builds, and the sitemap and navigation never
 * list it. The root layout opens it without sign-in or sync, so a snapshot never depends on a server.
 */
export default function ComponentGallery(): ReactElement {
  const params = useLocalSearchParams<{ theme?: string; page?: string }>();
  const insets = useSafeAreaInsets();
  const theme: GalleryTheme = params.theme === "light" ? "light" : "dark";
  const page = Number(params.page ?? "1");
  if (!Number.isInteger(page) || page < 1 || page > galleryPages.length) {
    return <View testID="gallery-end" style={{ flex: 1 }} />;
  }
  return (
    <>
      {/* The status bar's clock and battery change from run to run; the snapshots leave it out. */}
      <StatusBar hidden />
      <GalleryScreen
        theme={theme}
        page={page}
        insets={{ top: insets.top, bottom: insets.bottom }}
        testID={`gallery-page-${page}`}
      />
    </>
  );
}
