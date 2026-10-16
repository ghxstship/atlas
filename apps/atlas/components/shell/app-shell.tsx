import { listWorkspaces } from "@xos/data";
import { listFavorites } from "@xos/data/settings";
import { flattenRoutes, getNode, isNodeVisible } from "@xos/ia";
import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { getLocale } from "next-intl/server";
import { selectableLocales } from "@/i18n/negotiate";
import { getMyOrganizations, type OrgContext } from "@/lib/shell/context";
import { buildShellNav, NAV_ICONS, type NavLinkModel } from "@/lib/shell/nav-model";
import { nodeHref, sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";
import { WORKSPACE_COOKIE } from "@/lib/shell/workspace";
import { THEME_COOKIE, themeFromCookie } from "@/lib/theme";
import { ShellFrame } from "./shell-frame";

/**
 * Server half of the Atlas shell: builds the navigation model from the sitemap for this viewer and
 * reads the orgs, workspaces and device preferences the client frame renders.
 */
export async function AppShell({ ctx, children }: { ctx: OrgContext; children: ReactNode }) {
  const [t, orgs, workspaces, locale, cookieStore, pinned] = await Promise.all([
    getTranslate(),
    getMyOrganizations(),
    listWorkspaces(ctx.viewer.db, ctx.org.id),
    getLocale(),
    cookies(),
    ctx.viewer.person
      ? listFavorites(ctx.viewer.db, { orgId: ctx.org.id, personId: ctx.viewer.person.id })
      : null,
  ]);
  if (!workspaces.ok) {
    throw new Error(`Cannot list workspaces: ${JSON.stringify(workspaces.error)}`);
  }
  if (pinned && !pinned.ok) {
    throw new Error(`Cannot list favorites: ${JSON.stringify(pinned.error)}`);
  }
  const nav = buildShellNav(sitemap, {
    nav: ctx.nav,
    role: ctx.role,
    persona: ctx.persona,
    params: { org: ctx.org.slug },
    t,
  });
  // Favorites (app.favorites): pages the person may still open, a pinned record opening in peek.
  const routed = new Set(flattenRoutes(sitemap).map((r) => r.id));
  const favorites: NavLinkModel[] = (pinned?.data ?? []).flatMap((f) => {
    if (!routed.has(f.nodeId) || !isNodeVisible(sitemap, f.nodeId, ctx.nav)) return [];
    const href = nodeHref(f.nodeId, { org: ctx.org.slug });
    if (href === undefined) return [];
    return [
      {
        id: `favorite-${f.id}`,
        label: t(getNode(sitemap, f.nodeId).node.label),
        href: f.targetId ? `${href}?peek=${f.targetId}` : href,
        icon: NAV_ICONS[f.nodeId] ?? "Star",
      },
    ];
  });
  const chosen = cookieStore.get(WORKSPACE_COOKIE)?.value ?? null;
  const workspace = workspaces.data.some((w) => w.slug === chosen) ? chosen : null;
  return (
    <ShellFrame
      org={{ name: ctx.org.name, slug: ctx.org.slug }}
      orgs={orgs.map((o) => {
        const best = o.roles[0];
        const role = best ? (best.name ?? t(`shell.roles.${best.code}`)) : "";
        return { name: o.name, slug: o.slug, role };
      })}
      nav={nav}
      favorites={favorites}
      workspaces={workspaces.data.map((w) => ({ slug: w.slug, name: w.name }))}
      workspace={workspace}
      locales={selectableLocales(process.env.NODE_ENV === "production")}
      locale={locale}
      theme={themeFromCookie(cookieStore.get(THEME_COOKIE)?.value)}
      email={ctx.viewer.email}
      canManageAi={ctx.capabilities.has("org.ai.write")}
    >
      {children}
    </ShellFrame>
  );
}
