import { usePreferences, useViewerTimeZone } from "@xos/ui";
import { scheduleViewOf, type ScheduleView } from "./format";

/**
 * The viewer's schedule view in a client component: their me.time_zone_display choice from the shell's
 * PreferencesProvider and their own zone, for `formatScheduleTime`.
 */
export function useScheduleView(): ScheduleView {
  return scheduleViewOf(usePreferences(), useViewerTimeZone());
}
