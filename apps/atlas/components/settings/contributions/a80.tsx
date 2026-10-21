import {
  getMyNotificationMatrix,
  getMyNotificationSettings,
  getMySmsStatus,
  getOrgNotificationDefaults,
} from "@xos/data/notification-settings";
import { NOTIFICATION_CATEGORIES, NOTIFICATION_CHANNEL_DEFAULTS } from "@xos/schemas/notifications";
import { InlineAlert } from "@/components/ui";
import {
  MyNotificationsForm,
  OrgNotificationDefaultsForm,
  type MemberRow,
  type OrgRow,
} from "@/components/settings/notification-forms";
import { MATRIX_CHANNELS } from "@/lib/settings/notification-matrix";
import { getTranslate } from "@/lib/shell/translate";
import type { SettingsContribution, SettingsPanelProps } from "./types";

/**
 * A80's settings panels (RRR-125, migration 1362, finding A65-021):
 *   Personal settings, Notifications   the member's matrix of categories by channel, resolved with the
 *                                      org's defaults and mandatory categories, plus quiet hours (in the
 *                                      member's time zone) and digest frequency (Section 4.5.6 item 8)
 *   Settings, Notifications            the org's defaults and mandatory categories (item 29)
 * Categories and channels come from the notification kind registry (packages/schemas/notification-kinds.yaml).
 */

function timeZoneOptions() {
  return ["UTC", ...Intl.supportedValuesOf("timeZone").filter((z) => z !== "UTC")].map((z) => ({
    value: z,
    label: z.replaceAll("_", " "),
  }));
}

async function MyNotificationsPanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  const [matrix, settings, sms] = await Promise.all([
    getMyNotificationMatrix(ctx.viewer.db, ctx.org.id),
    getMyNotificationSettings(ctx.viewer.db, ctx.org.id),
    getMySmsStatus(ctx.viewer.db, ctx.org.id),
  ]);
  if (!matrix.ok || !settings.ok || !sms.ok) {
    return <InlineAlert tone="danger">{t("settings.notifications.loadFailed")}</InlineAlert>;
  }
  const rows: MemberRow[] = NOTIFICATION_CATEGORIES.map((c) => ({
    category: c.code,
    urgent: c.urgent,
    cells: MATRIX_CHANNELS.map(({ channel }) => {
      const cell = matrix.data.find((m) => m.category === c.code && m.channel === channel);
      return { channel, enabled: cell?.enabled ?? false, locked: cell?.locked ?? false };
    }),
  }));
  const s = settings.data;
  return (
    <MyNotificationsForm
      org={ctx.org.slug}
      rows={rows}
      timeZones={timeZoneOptions()}
      sms={{
        phone: sms.data.phone === null ? null : `•••${sms.data.phone.slice(-4)}`,
        mayText: sms.data.mayText,
      }}
      settings={{
        timeZone: s?.timeZone ?? "UTC",
        quietStart: s?.quietHoursStart ?? "",
        quietEnd: s?.quietHoursEnd ?? "",
        digestFrequency: s?.digestFrequency ?? "Off",
        digestHour: s?.digestHour ?? 8,
      }}
    />
  );
}

async function OrgDefaultsPanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  const stored = await getOrgNotificationDefaults(ctx.viewer.db, ctx.org.id);
  if (!stored.ok) {
    return <InlineAlert tone="danger">{t("settings.notifications.loadFailed")}</InlineAlert>;
  }
  const platformDefault = (channel: string) =>
    NOTIFICATION_CHANNEL_DEFAULTS.find((c) => c.code === channel)?.enabledByDefault ?? false;
  const rows: OrgRow[] = NOTIFICATION_CATEGORIES.map((c) => ({
    category: c.code,
    urgent: c.urgent,
    mandatory: stored.data.mandatory.includes(c.code),
    cells: MATRIX_CHANNELS.map(({ channel }) => ({
      channel,
      enabled:
        stored.data.defaults.find((d) => d.category === c.code && d.channel === channel)?.enabled ??
        platformDefault(channel),
    })),
  }));
  return (
    <OrgNotificationDefaultsForm
      org={ctx.org.slug}
      rows={rows}
      canEdit={ctx.capabilities.has("org.notifications.write")}
    />
  );
}

export const contributions: readonly SettingsContribution[] = [
  { node: "me.notifications", order: 10, Panel: MyNotificationsPanel },
  { node: "settings.notifications", order: 10, Panel: OrgDefaultsPanel },
];
