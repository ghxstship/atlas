import { listMyEngagements } from "@xos/data/gateway";
import { isTimeZone } from "@xos/data/calendar";
import { cookies, headers } from "next/headers";
import { scheduleViewFrom } from "@/lib/format";
import { negotiatedLocale } from "@/i18n/request";
import type { ReactNode } from "react";
import { ReacceptancePrompt } from "@/components/legal/reacceptance-banner";
import { GatewayFrame } from "@/components/shell/gateway-frame";
import { ReporterUser } from "@/components/shell/reporter-user";
import { selectableLocales } from "@/i18n/negotiate";
import { docsSiteUrl, env } from "@/lib/env";
import { buildNav } from "@/lib/shell/nav-model";
import { requireContext } from "@/lib/shell/context";
import { sitemap } from "@/lib/shell/sitemap";
import { enumLabelKey, getTranslate } from "@/lib/shell/translate";
import { THEME_COOKIE, preferenceFromCookie } from "@/lib/theme";
import { getPersonalSettings } from "@/lib/shell/personal-settings";
import {
  PREFERENCES_COOKIE,
  encodePreferences,
  preferencesFromSettings,
} from "@xos/ui/preferences";

/**
 * Every signed-in Gateway page renders inside the Gateway shell. The navigation comes from the
 * sitemap for the person's standing; the brand is the org's on its custom domain, else the
 * platform's (Section 4.4.7). Only the platform brand links to the docs site's help center. After a
 * material change to a document the person accepted, such as the Worker Terms, every page opens with
 * the re-acceptance prompt (Section 14.4, A82).
 */
export default async function ShellLayout({ children }: { children: ReactNode }) {
  const path = (await headers()).get("x-gateway-path") ?? "/home";
  const ctx = await requireContext(path);
  const [t, locale, cookieStore, engagements, settings] = await Promise.all([
    getTranslate(),
    negotiatedLocale(),
    cookies(),
    listMyEngagements(ctx.db),
    // The person's own settings apply in Gateway too (Section 4.5.6 personal settings, A65-001).
    getPersonalSettings(ctx.db),
  ]);
  // The person's own zone, which schedule times show in under "my time zone" (me.time_zone_display).
  const schedule = scheduleViewFrom(
    (key) => (settings.ok ? settings.data.get(key)?.value : undefined),
    isTimeZone,
  );
  const preferences = encodePreferences(
    preferencesFromSettings((key) => (settings.ok ? settings.data.get(key)?.value : undefined)),
  );
  const nav = buildNav(sitemap, ctx.nav);
  const label = <T extends { label: string }>(item: T): T => ({ ...item, label: t(item.label) });
  const orgs = new Map<string, string>();
  if (engagements.ok) for (const e of engagements.data) orgs.set(e.orgId, e.orgName);
  const brandName = ctx.brand.kind === "org" ? ctx.brand.org.name : t("shell.gateway.name");
  return (
    <GatewayFrame
      brandName={brandName}
      showPoweredBy={ctx.brand.kind === "org" && ctx.brand.org.showPoweredBy}
      primary={nav.primary.map(label)}
      bottomBar={nav.bottomBar.map(label)}
      avatar={nav.avatar.map(label)}
      commands={nav.commands.map((c) => ({
        id: c.id,
        href: c.href,
        icon: c.icon,
        label: [...(c.context ?? []).slice(-1), c.label].map((k) => t(k)).join(" · "),
      }))}
      personName={ctx.personName ?? ctx.email ?? ""}
      email={ctx.email}
      accounts={ctx.accounts.map((a) => ({
        id: a.id,
        name: a.name,
        role: a.roles[0] ? t(enumLabelKey("accountRole", a.roles[0])) : "",
      }))}
      actingId={ctx.acting?.id ?? null}
      orgs={[...orgs]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name))}
      theme={preferenceFromCookie(cookieStore.get(THEME_COOKIE)?.value)}
      locale={locale}
      locales={selectableLocales(process.env.NODE_ENV === "production")}
      preferences={preferences}
      storedPreferences={cookieStore.get(PREFERENCES_COOKIE)?.value ?? ""}
      viewerTimeZone={schedule.viewerZone}
      docsUrl={ctx.brand.kind === "org" ? null : docsSiteUrl(env())}
    >
      <ReporterUser personId={ctx.personId} />
      <ReacceptancePrompt db={ctx.db} />
      {children}
    </GatewayFrame>
  );
}
