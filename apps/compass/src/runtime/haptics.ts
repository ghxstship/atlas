/**
 * The design system's haptic kinds (ThemeProvider onHaptic, @xos/ui-native) on expo-haptics, for the
 * haptic confirmation of Section 4.3 field ergonomics. Compass passes it only while the person keeps
 * haptics on in Settings.
 */
import * as Haptics from "expo-haptics";
import type { HapticKind } from "@xos/ui-native/theme";

export function hapticCall(kind: HapticKind): () => Promise<void> {
  switch (kind) {
    case "selection":
      return () => Haptics.selectionAsync();
    case "success":
      return () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    case "warning":
      return () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    case "impact":
      return () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  }
}

export function playHaptic(kind: HapticKind): void {
  hapticCall(kind)().catch((error: unknown) => console.warn("Haptic feedback failed", error));
}
