import { BrowserPushSetting } from "@xos/ui/pwa/browser-push";
import { getTranslations } from "next-intl/server";
import { env } from "@/lib/env";
import { registerWebPushAction, revokeWebPushAction } from "@/lib/pwa/push-actions";
import type { SettingsContribution } from "./types";

/**
 * A96's settings panel (RRR-141, finding A65-023, Section 4.10): Personal settings, Notifications gains Browser
 * Notifications, which subscribes this browser to Web Push for every org the person belongs to (1533). It sits below
 * A80's matrix: browser pushes ride the Push channel, so its choices and quiet hours apply.
 */
async function BrowserNotificationsPanel() {
  const t = await getTranslations("firstRun.push");
  const app = "Atlas";
  return (
    <BrowserPushSetting
      vapidPublicKey={env().VAPID_PUBLIC_KEY ?? null}
      labels={{
        title: t("title"),
        body: t("body", { app }),
        turnOn: t("turnOn"),
        turnOff: t("turnOff"),
        on: t("on"),
        off: t("off"),
        blocked: t("blocked", { app }),
        unsupported: t("unsupported", { app }),
        unavailable: t("unavailable"),
        failed: t("failed"),
      }}
      onRegister={registerWebPushAction}
      onRevoke={revokeWebPushAction}
    />
  );
}

export const contributions: readonly SettingsContribution[] = [
  { node: "me.notifications", order: 20, Panel: BrowserNotificationsPanel },
];
