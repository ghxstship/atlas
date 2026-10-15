import { listMyEngagements } from "@xos/data";
import { cookies, headers } from "next/headers";
import { getLocale } from "next-intl/server";
import type { ReactNode } from "react";
import { GatewayFrame } from "@/components/shell/gateway-frame";
import { selectableLocales } from "@/i18n/negotiate";
import { buildNav } from "@/lib/shell/nav-model";
import { requireContext } from "@/lib/shell/context";
import { sitemap } from "@/lib/shell/sitemap";
import { enumLabelKey, getTranslate } from "@/lib/shell/translate";
import { THEME_COOKIE, preferenceFromCookie } from "@/lib/theme";

/**
 * Every signed-in Gateway page renders inside the Gateway shell. The navigation comes from the
 * sitemap for the person's standing; the brand is the org's on its custom domain, else the
 * platform's (Section 4.4.7).
 */
export default async function ShellLayout({ children }: { children: ReactNode }) {
  const path = (await headers()).get("x-gateway-path") ?? "/home";
  const ctx = await requireContext(path);
  const [t, locale, cookieStore, engagements] = await Promise.all([
    getTranslate(),
    getLocale(),
    cookies(),
    listMyEngagements(ctx.db),
  ]);
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
      commands={nav.commands.map(label)}
      personName={ctx.personName ?? ctx.email ?? ""}
      email={ctx.email}
      accounts={ctx.accounts.map((a) => ({
        id: a.id,
        name: a.name,
        role: a.roles[0] ? t(enumLabelKey("accountRole", a.roles[0])) : "",
      }))}
      actingId={ctx.acting?.id ?? null}
      orgs={[...orgs].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))}
      theme={preferenceFromCookie(cookieStore.get(THEME_COOKIE)?.value)}
      locale={locale}
      locales={selectableLocales(process.env.NODE_ENV === "production")}
    >
      {children}
    </GatewayFrame>
  );
}
