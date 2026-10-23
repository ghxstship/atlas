import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { BrowserPushSetting } from "@xos/ui/pwa/browser-push";
import { SettingsSection } from "@/components/settings/sections";
import { getNode } from "@xos/ia";
import { env } from "@/lib/env";
import { registerWebPushAction, revokeWebPushAction } from "@/lib/pwa/push-actions";
import { requireNode, sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslate();
  return { title: t(getNode(sitemap, "settings.notifications").node.label) };
}

/**
 * Settings section settings.notifications (Section 4.5.8); its content comes from the settings sections, then
 * Browser Notifications for this browser (A96, Section 4.10, migration 1533), which ride the Push channel above.
 */
export default async function Page() {
  const [ctx, t] = await Promise.all([
    requireNode("settings.notifications"),
    getTranslations("firstRun.push"),
  ]);
  const app = ctx.brand.kind === "org" ? ctx.brand.org.name : "Gateway";
  return (
    <>
      <SettingsSection node="settings.notifications" ctx={ctx} />
      <div className="mt-16">
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
      </div>
    </>
  );
}
