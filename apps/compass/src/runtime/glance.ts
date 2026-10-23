/**
 * Compass outside the app (A65-011 part 4): the iOS home screen and Lock Screen widgets, fed through the App
 * Group by the Live Activity module, and the Android ongoing notification for the running shift or the next
 * cue. The content comes from src/domain/glance.ts; this only hands it to the platform, and only when it
 * changed.
 */
import * as Notifications from "expo-notifications";
import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { CompassLiveActivity } from "../../modules/compass-live-activity";
import type { OngoingContent, WidgetPayload } from "../domain/glance";

/** Writes the widgets' JSON when it changes; the module reloads their timelines. iOS only. */
export function useHomeWidgets(payload: WidgetPayload | null): void {
  const json = payload ? JSON.stringify(payload) : "";
  const written = useRef<string | null>(null);
  useEffect(() => {
    const native = CompassLiveActivity;
    if (!native || written.current === json) return;
    try {
      native.setWidgetData(json);
      written.current = json;
    } catch (error) {
      // A build from before the widgets (or a failed write) leaves the widgets as they were.
      console.warn("[compass] widget data not written", error);
    }
  }, [json]);
}

export const ONGOING_ID = "compass-ongoing";
const CHANNEL = "compass-ongoing";

/**
 * At sign-out (here or remotely from Atlas): the widgets forget the person's shifts and the ongoing
 * notification goes, so nothing of the session stays on the home screen or in the tray (Section 13).
 */
export function clearGlance(): void {
  try {
    CompassLiveActivity?.setWidgetData("");
  } catch {
    // An older build without widgets has nothing to clear.
  }
  if (Platform.OS === "android")
    void Notifications.dismissNotificationAsync(ONGOING_ID).catch(() => undefined);
}

/**
 * Keeps the running shift or the next cue in the Android notification tray as an ongoing (sticky)
 * notification, the Android counterpart of the iOS Live Activity, and removes it when there is nothing to
 * show. Quiet: a low-importance channel with no sound or vibration. Skipped where notifications are not
 * allowed; Today's in-app card is always there.
 */
export function useOngoingNotification(
  content: OngoingContent | null,
  channelName: string,
  link: string,
): void {
  const key = content ? JSON.stringify(content) : "";
  const shown = useRef<string>("");
  useEffect(() => {
    if (Platform.OS !== "android" || shown.current === key) return;
    let live = true;
    void (async () => {
      if (!key) {
        await Notifications.dismissNotificationAsync(ONGOING_ID).catch(() => undefined);
        shown.current = "";
        return;
      }
      const permission = await Notifications.getPermissionsAsync();
      if (!live || !permission.granted) return;
      await Notifications.setNotificationChannelAsync(CHANNEL, {
        name: channelName,
        importance: Notifications.AndroidImportance.LOW,
        sound: null,
        vibrationPattern: null,
        enableVibrate: false,
        showBadge: false,
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      });
      const next = JSON.parse(key) as OngoingContent;
      // The same identifier replaces the notification in place.
      await Notifications.scheduleNotificationAsync({
        identifier: ONGOING_ID,
        content: {
          title: next.title,
          body: next.body,
          sticky: true,
          autoDismiss: false,
          priority: Notifications.AndroidNotificationPriority.LOW,
          data: { url: link },
        },
        trigger: { channelId: CHANNEL },
      });
      shown.current = key;
    })().catch((error: unknown) => console.warn("[compass] ongoing notification", error));
    return () => {
      live = false;
    };
  }, [key, channelName, link]);
}
