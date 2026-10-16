import { useSyncExternalStore } from "react";
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

/*
 * The system Reduce Motion (iOS) or Remove animations (Android) setting, read once for the app and
 * kept current through its change event, so every component shares one subscription (A23-008).
 */
let reduceMotion = false;
let watching = false;
const listeners = new Set<() => void>();

function setReduceMotion(next: boolean): void {
  if (next === reduceMotion) return;
  reduceMotion = next;
  for (const listener of listeners) listener();
}

function watchReduceMotion(): void {
  if (watching) return;
  watching = true;
  AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
  AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion, (error: unknown) => {
    // The setting stays off, which keeps motion; report it rather than hide it.
    console.error("Cannot read the Reduce Motion setting", error);
  });
}

function subscribe(listener: () => void): () => void {
  watchReduceMotion();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True while the person asks the system for less motion: skip slides, fills and other animation. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => reduceMotion,
    () => false,
  );
}
