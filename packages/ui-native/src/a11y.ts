import { AccessibilityInfo } from "react-native";

/**
 * Speaks a status message through the platform screen reader (WCAG 4.1.3 status messages): VoiceOver
 * and TalkBack both read AccessibilityInfo.announceForAccessibility. iOS has no live regions, so a
 * component that changes a status in place must announce it; components keep accessibilityLiveRegion
 * as well, which TalkBack reads on Android. Empty messages are ignored.
 */
export function announce(message: string | null | undefined): void {
  const text = message?.trim();
  if (!text) return;
  AccessibilityInfo.announceForAccessibility(text);
}
