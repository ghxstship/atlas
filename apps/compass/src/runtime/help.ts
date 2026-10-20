/**
 * Remembers the screen the person was using, so Help (opened from More or Settings) shows the
 * articles for that screen rather than for the menu it was opened from (Section 11.16).
 */
import { usePathname } from "expo-router";
import { useEffect } from "react";
import { helpNodeFor, isHelpHub } from "../domain/help";

let lastScreen: string | null = null;

/** The path of the last screen visited that has help of its own, or null before any. */
export function lastHelpScreen(): string | null {
  return lastScreen;
}

/** Records each screen the person opens, looking past More, Settings and Help; renders nothing. */
export function HelpScreenTracker(): null {
  const pathname = usePathname();
  useEffect(() => {
    if (!isHelpHub(pathname) && helpNodeFor(pathname) !== null) lastScreen = pathname;
  }, [pathname]);
  return null;
}
