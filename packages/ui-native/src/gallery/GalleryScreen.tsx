import { useEffect, useState, type ReactElement } from "react";
import { View } from "react-native";
import { Text } from "../components/foundations.tsx";
import { ThemeProvider, useTheme, type ThemeName } from "../theme/index.ts";
import { holdClock } from "./clock.ts";
import { galleryPages, type GalleryPage } from "./pages.tsx";

/** The themes the gallery snapshots (Section 11.4: Dark is the default, Light the other theme people pick). */
export const galleryThemes = ["dark", "light"] as const satisfies readonly ThemeName[];
export type GalleryTheme = (typeof galleryThemes)[number];

export interface GalleryScreenProps {
  theme: GalleryTheme;
  /** 1-based page number; out of range shows the first page. */
  page: number;
  /** The device's safe area, so nothing sits under the notch or the home indicator. */
  insets?: { top: number; bottom: number };
  testID?: string;
}

/** The page shown for a page number: in range, or the first. */
export function galleryPage(page: number): { index: number; page: GalleryPage } {
  const index = Number.isInteger(page) && page >= 1 && page <= galleryPages.length ? page - 1 : 0;
  return { index, page: galleryPages[index] as GalleryPage };
}

function Page({
  index,
  page,
  insets,
  testID,
}: {
  index: number;
  page: GalleryPage;
  insets: { top: number; bottom: number };
  testID: string | undefined;
}): ReactElement {
  const theme = useTheme();
  return (
    <View
      {...(testID === undefined ? {} : { testID })}
      style={{
        flex: 1,
        gap: theme.space["16"],
        paddingTop: insets.top + theme.space["8"],
        paddingBottom: insets.bottom,
        paddingHorizontal: theme.space["16"],
        backgroundColor: theme.color.bgCanvas,
      }}
    >
      <Text variant="mono13" tone="tertiary">
        {`${theme.name} ${index + 1}/${galleryPages.length} ${page.key}`}
      </Text>
      {page.entries.map((entry) => (
        <View
          key={entry.component}
          testID={`gallery-${entry.component}`}
          style={{ gap: theme.space["6"] }}
        >
          <Text variant="label13" tone="secondary">
            {entry.component}
          </Text>
          {entry.render()}
        </View>
      ))}
    </View>
  );
}

/**
 * One gallery page in one theme, for the Maestro snapshots (A141). The clock is held while it is open
 * (clock.ts); the hold starts during the first render, before any component below starts a timer.
 */
export function GalleryScreen({
  theme,
  page,
  insets = { top: 0, bottom: 0 },
  testID,
}: GalleryScreenProps): ReactElement {
  const [firstHold] = useState(holdClock);
  // The effect takes over the first render's hold, so a remount (React's StrictMode) holds it again.
  useEffect(() => {
    const hold = holdClock();
    firstHold();
    return hold;
  }, [firstHold]);
  const shown = galleryPage(page);
  return (
    <ThemeProvider preference={theme}>
      <Page index={shown.index} page={shown.page} insets={insets} testID={testID} />
    </ThemeProvider>
  );
}
