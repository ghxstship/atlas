import { listFavorites } from "@xos/data/settings";
import { listShortcutBindings, listSidebarLayout } from "@xos/data/shell-preferences";
import { findRoute, flattenRoutes, getNode, isNodeVisible } from "@xos/ia";
import { platformOf, SHORTCUT_REGISTRY } from "@xos/schemas/shortcuts";
import type { ReactNode } from "react";
import { cookies, headers } from "next/headers";
import { negotiatedLocale } from "@/i18n/request";
import { lockedLocale, selectableLocales } from "@/i18n/negotiate";
import { PATH_HEADER } from "@/lib/auth/assurance";
import { getAiFeatures } from "@/lib/aurora/features";
import { observability } from "@/lib/observability";
import { getOrgWorkspaces } from "@/lib/shell/active-workspace";
import { breadcrumbItems } from "@/lib/shell/breadcrumbs";
import { getMyOrganizations, type OrgContext } from "@/lib/shell/context";
import { createItems } from "@/lib/shell/create-menu";
import { buildShellNav, NAV_ICONS } from "@/lib/shell/nav-model";
import { recentProjects } from "@/lib/shell/recents";
import { buildShellKeys, goHints } from "@/lib/shell/shell-keys";
import { nodeHref, sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";
import { getShellSettings } from "@/lib/shell/org-settings";
import { getOrgTimeZone } from "@/lib/shell/time-zone";
import { PREFERENCES_COOKIE } from "@xos/ui/preferences";
import { THEME_COOKIE, themeFromCookie } from "@/lib/theme";
import { ReporterUser } from "./reporter-user";
import { ShellFrame } from "./shell-frame";
import type { FavoriteLink } from "./sidebar-favorites";

/** A preference the shell can do without: read failures fall back to the default and are logged. */
function orDefault<T>(
  result: { ok: true; data: T } | { ok: false; error: unknown } | null,
  fallback: T,
  what: string,
): T {
  if (result === null) return fallback;
  if (result.ok) return result.data;
  observability.logger.error("Cannot read a shell preference; using the default", {
    preference: what,
    error: result.error,
  });
  return fallback;
}

/**
 * Server half of the Atlas shell: builds the navigation model from the sitemap for this viewer, with
 * their sidebar layout and the projects they opened most recently, their keyboard shortcuts (the
 * registry with their own bindings) and the Create menu they may use, and reads the orgs,
 * workspaces and device preferences the client frame renders.
 */
export async function AppShell({ ctx, children }: { ctx: OrgContext; children: ReactNode }) {
  const person = ctx.viewer.person;
  const [
    t,
    orgs,
    workspaces,
    locale,
    cookieStore,
    pinned,
    bindings,
    layout,
    headerStore,
    ai,
    recent,
  ] = await Promise.all([
    getTranslate(),
    getMyOrganizations(),
    getOrgWorkspaces(ctx.viewer.db, ctx.org.id),
    negotiatedLocale(),
    cookies(),
    person ? listFavorites(ctx.viewer.db, { orgId: ctx.org.id, personId: person.id }) : null,
    person ? listShortcutBindings(ctx.viewer.db, "Atlas") : null,
    person ? listSidebarLayout(ctx.viewer.db, ctx.org.id) : null,
    headers(),
    getAiFeatures(ctx),
    recentProjects(ctx),
  ]);
  if (pinned && !pinned.ok) {
    throw new Error(`Cannot list favorites: ${JSON.stringify(pinned.error)}`);
  }
  const params = { org: ctx.org.slug };
  // Navigation shortcuts open the sitemap nodes the person may see (Section 11.2, G then a letter).
  const goTargets = new Map<string, { href: string; label: string }>();
  for (const shortcut of SHORTCUT_REGISTRY.shells.atlas.shortcuts) {
    const href = shortcut.go === null ? undefined : nodeHref(shortcut.go, params);
    if (
      shortcut.go === null ||
      href === undefined ||
      !isNodeVisible(sitemap, shortcut.go, ctx.nav)
    ) {
      continue;
    }
    goTargets.set(shortcut.go, { href, label: t(getNode(sitemap, shortcut.go).node.label) });
  }
  const keys = buildShellKeys(SHORTCUT_REGISTRY, {
    platform: platformOf({
      platform: headerStore.get("sec-ch-ua-platform") ?? undefined,
      userAgent: headerStore.get("user-agent") ?? undefined,
    }),
    custom: orDefault(bindings, {}, "shortcut bindings"),
    goTargets,
  });
  const nav = buildShellNav(sitemap, {
    nav: ctx.nav,
    role: ctx.role,
    persona: ctx.persona,
    params,
    t,
    layout: orDefault(layout, [], "the sidebar layout"),
    hints: goHints(keys),
    recentProjects: recent,
  });
  // Favorites (app.favorites): pages the person may still open, a pinned record opening in peek.
  const routed = new Set(flattenRoutes(sitemap).map((r) => r.id));
  const favorites: FavoriteLink[] = (pinned?.data ?? []).flatMap((f) => {
    if (!routed.has(f.nodeId) || !isNodeVisible(sitemap, f.nodeId, ctx.nav)) return [];
    const href = nodeHref(f.nodeId, { org: ctx.org.slug });
    if (href === undefined) return [];
    return [
      {
        id: `favorite-${f.id}`,
        favoriteId: f.id,
        label: t(getNode(sitemap, f.nodeId).node.label),
        href: f.targetId ? `${href}?peek=${f.targetId}` : href,
        icon: NAV_ICONS[f.nodeId] ?? "Star",
      },
    ];
  });
  // The person's display preferences in this org and workspace (Section 4.5.6, A65-001).
  const settings = await getShellSettings(ctx.viewer.db, ctx.org.id, workspaces.active?.id ?? null);
  // An org that locks its language (locale.language) leaves no language to choose.
  const locales =
    lockedLocale(settings.language) === null
      ? selectableLocales(process.env.NODE_ENV === "production")
      : [];
  // The page this render is for (the path the proxy forwards; none on a prefetch): its breadcrumbs
  // and node, so the client sitemap loads only once the person can navigate (ADR 0027).
  const path = headerStore.get(PATH_HEADER)?.split("?")[0] ?? null;
  const org = { name: ctx.org.name, slug: ctx.org.slug };
  const page = path
    ? {
        path,
        crumbs: breadcrumbItems(sitemap, path, { org, workspace: workspaces.active?.name }, t),
        nodeId: findRoute(sitemap, path)?.id ?? null,
      }
    : null;
  // Quick add in the Create menu creates records, read on the org's calendar (Section 11.7).
  const quickAdd = ctx.capabilities.has("work.record.write")
    ? { org: ctx.org.slug, timeZone: await getOrgTimeZone(ctx) }
    : null;
  return (
    <ShellFrame
      org={org}
      page={page}
      orgs={orgs.map((o) => {
        const best = o.roles[0];
        const role = best ? (best.name ?? t(`shell.roles.${best.code}`)) : "";
        return { name: o.name, slug: o.slug, role };
      })}
      nav={nav}
      favorites={favorites}
      workspaces={workspaces.all.map((w) => ({ slug: w.slug, name: w.name }))}
      workspace={workspaces.active?.slug ?? null}
      locales={locales}
      locale={locale}
      theme={themeFromCookie(cookieStore.get(THEME_COOKIE)?.value)}
      email={ctx.viewer.email}
      canManageAi={ctx.capabilities.has("org.ai.write")}
      aiFeatures={ai}
      preferences={settings.encoded}
      viewerTimeZone={settings.viewerTimeZone}
      storedPreferences={cookieStore.get(PREFERENCES_COOKIE)?.value ?? ""}
      keys={keys}
      create={createItems(sitemap, { nav: ctx.nav, capabilities: ctx.capabilities, params, t })}
      quickAdd={quickAdd}
    >
      <ReporterUser personId={ctx.viewer.person?.id ?? null} />
      {children}
    </ShellFrame>
  );
}
