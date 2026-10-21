"use client";

import { resolveBreadcrumbs } from "@xos/ia";
import {
  AppShell,
  Breadcrumbs,
  Button,
  PreferencesProvider,
  Select,
  Sidebar,
  TabBar,
  type MenuItem,
  type NavItem,
} from "@xos/ui";
import { applyDocumentAttributes, decodePreferences, preferencesCookie } from "@xos/ui/preferences";
import type { Route } from "next";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { clientSitemap } from "@/ia/sitemap.client.generated";
import type { AtlasLocale } from "@/i18n/negotiate";
import type { CreateItem } from "@/lib/shell/create-order";
import type { NavLinkModel, ShellNav } from "@/lib/shell/nav-model";
import type { ShellKeys } from "@/lib/shell/shell-keys";
import { selectOrganization, setLocale, setTheme, setWorkspace } from "@/lib/shell/actions";
import { toggleFavoriteAction } from "@/lib/settings/favorites-actions";
import type { Theme } from "@/lib/theme";
import { AuroraCenter, openAurora } from "@/components/aurora/aurora-center";
import { HelpCenter, openHelpArticle } from "@/components/help/help-center";
import { DeferredDropdownMenu, ShellOrgSwitcher } from "./deferred-menus";
import { onDemand, useOnDemand } from "./on-demand";
import { broadcast, SessionWatcher } from "./session-watcher";
import { ShellKeysContext } from "./shell-keys-context";
import type { KeyState } from "./key-dispatch";

/** The command menu (cmdk and the help article index) loads the first time it opens (A24-009). */
const commandMenu = onDemand(() => import("./shell-command"));
/** The Create menu shares the command menu's dialog and loads the first time it opens. */
const createMenu = onDemand(() => import("./shell-create"));
/** The key handler loads once the shell has hydrated, outside the route's first JavaScript. */
const keyHandler = onDemand(() => import("./shell-keys"));

export interface ShellFrameProps {
  readonly org: { readonly name: string; readonly slug: string };
  readonly orgs: readonly { readonly name: string; readonly slug: string; readonly role: string }[];
  readonly nav: ShellNav;
  /** The person's pinned pages and records in this org (app.favorites). */
  readonly favorites: readonly NavLinkModel[];
  readonly workspaces: readonly { readonly slug: string; readonly name: string }[];
  readonly workspace: string | null;
  readonly locales: readonly AtlasLocale[];
  readonly locale: AtlasLocale;
  readonly theme: Theme;
  readonly email: string | null;
  /** Whether the viewer can turn AI features on (org.ai.write), for the Aurora panel. */
  readonly canManageAi: boolean;
  /** The person's display preferences resolved from their settings (encoded as the cookie keeps them). */
  readonly preferences: string;
  /** The preferences cookie this page was rendered with. */
  readonly storedPreferences: string;
  /** The person's keyboard shortcuts: the registry with their own bindings (lib/shell/shell-keys.ts). */
  readonly keys: ShellKeys;
  /** What the person may create, for the Create menu (lib/shell/create-menu.ts). */
  readonly create: readonly CreateItem[];
  readonly children: ReactNode;
}

type Translate = (key: string, values?: Record<string, string>) => string;

/**
 * The Atlas shell on @xos/ui (A05): org switcher, workspace filter, sitemap sidebar with favorites,
 * role-default groups and the person's own layout, the Create menu, breadcrumbs, account menu,
 * command menu, the phone bottom bar, focus mode and the session dialog. Every item comes from the
 * navigation model built from ia/sitemap.yaml on the server, and every shortcut (Cmd or Ctrl+K, `/`,
 * C, `?`, G then a letter, focus mode) from the shortcut registry with the person's own bindings.
 */
export function ShellFrame(props: ShellFrameProps) {
  const { org, nav } = props;
  const router = useRouter();
  const pathname = usePathname();
  const tRoot = useTranslations();
  const t = tRoot as unknown as Translate;
  const [commandOpen, setCommandOpen] = useState(false);
  const command = useOnDemand(commandMenu, commandOpen);
  const [createOpen, setCreateOpen] = useState(false);
  const create = useOnDemand(createMenu, createOpen);
  // The first key of a sequence (G) while the shell waits for the next one; it shows the hint.
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const keyModule = useOnDemand(keyHandler, pendingKey !== null);
  const [focus, setFocus] = useState(false);
  // The navigation drawer below lg: the top bar's menu button and the bottom bar's Menu tab both
  // open it, and moving to another page closes it (A59-001): it is open on the page it opened on.
  const [menuOpenOn, setMenuOpenOn] = useState<string | null>(null);
  const menuOpen = menuOpenOn === pathname;
  const setMenuOpen = useCallback(
    (open: boolean) => setMenuOpenOn(open ? pathname : null),
    [pathname],
  );
  const [favoriteError, setFavoriteError] = useState<string | null>(null);
  const signOutForm = useRef<HTMLFormElement>(null);

  const go = useCallback((href: string) => router.push(href as Route), [router]);

  /** Sidebar items navigate client side; the anchor stays for middle-click and screen readers. */
  const toItem = useCallback(
    (l: NavLinkModel): NavItem => ({
      label: l.label,
      icon: l.icon,
      href: l.href,
      onSelect: ((event: MouseEvent) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        go(l.href);
      }) as unknown as () => void,
    }),
    [go],
  );

  const active = useMemo(() => {
    const all = [...nav.top, ...nav.pinned, ...nav.groups.flatMap((g) => g.items), ...nav.footer];
    const match = all
      .filter((l) => pathname === l.href || pathname.startsWith(`${l.href}/`))
      .sort((a, b) => b.href.length - a.href.length)[0];
    return match?.label;
  }, [nav, pathname]);

  // What the key handler acts on, kept current as the person's keys change; read once per key.
  const keyState = useRef<KeyState | null>(null);
  useEffect(() => {
    keyState.current = {
      keys: props.keys,
      handlers: {
        go,
        pending: setPendingKey,
        command: (id) => {
          if (id === "command-menu") setCommandOpen((o) => !o);
          else if (id === "search") setCommandOpen(true);
          else if (id === "create-menu") setCreateOpen(true);
          else if (id === "help") openHelpArticle("");
          else if (id === "focus-mode") setFocus((f) => !f);
          else if (id === "aurora") openAurora(true);
        },
      },
    };
  }, [props.keys, go]);
  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    const root = document.documentElement.dataset;
    keyHandler.load().then(
      (m) => {
        if (!live) return;
        stop = m.installShellKeys(keyState);
        // Marks the document once the shell's shortcuts work, Aurora's among them.
        root["shellReady"] = "";
        root["auroraReady"] = "";
      },
      (error: unknown) => console.error("Could not load the keyboard shortcuts", error),
    );
    return () => {
      live = false;
      stop?.();
      delete root["shellReady"];
      delete root["auroraReady"];
    };
  }, []);

  // Settings changed here or in Gateway or Compass reach this device: apply them now and keep the cookie
  // in step, so the next page renders with them (A65-001).
  const { preferences, storedPreferences } = props;
  const displayPreferences = useMemo(() => decodePreferences(preferences), [preferences]);
  useEffect(() => {
    if (preferences === storedPreferences) return;
    applyDocumentAttributes(document.documentElement, displayPreferences);
    document.cookie = preferencesCookie(preferences, window.location.protocol === "https:");
  }, [preferences, storedPreferences, displayPreferences]);

  const workspaceName = props.workspaces.find((w) => w.slug === props.workspace)?.name;
  const crumbs = resolveBreadcrumbs(
    clientSitemap,
    pathname,
    workspaceName ? { workspace: workspaceName } : {},
  ).map((c) => {
    if (c.kind === "org") return { label: org.name, href: `/${org.slug}/home` };
    if (c.kind === "workspace") return { label: c.value };
    if (c.kind === "node") return { label: t(c.label), href: c.href };
    return { label: c.value, ...(c.href ? { href: c.href } : {}) };
  });

  const account = nav.account;
  const accountItems: MenuItem[] = [
    ...(account
      ? [{ label: account.label, icon: account.icon, onSelect: () => go(account.href) }]
      : []),
    { separator: true },
    { heading: t("shell.chrome.language") },
    ...props.locales.map((l) => ({
      label: t(`shell.chrome.locales.${l}`),
      active: l === props.locale,
      onSelect: async () => {
        await setLocale(l);
        broadcast("preferences");
        router.refresh();
      },
    })),
    { separator: true },
    { heading: t("shell.chrome.theme") },
    ...(["dark", "light"] as const).map((theme) => ({
      label: t(theme === "dark" ? "shell.chrome.themeDark" : "shell.chrome.themeLight"),
      active: theme === props.theme,
      onSelect: async () => {
        await setTheme(theme);
        broadcast("preferences");
        router.refresh();
      },
    })),
    { separator: true },
    {
      label: t("shell.chrome.focusMode"),
      ...(props.keys.display["focus-mode"] ? { shortcut: props.keys.display["focus-mode"] } : {}),
      onSelect: () => setFocus(true),
    },
    {
      label: t("shell.auth.signOut"),
      icon: "LogOut",
      onSelect: () => signOutForm.current?.requestSubmit(),
    },
  ];

  const sidebar = (
    <>
      <Button
        variant="ghost"
        icon="Search"
        {...(props.keys.display["command-menu"]
          ? { shortcut: props.keys.display["command-menu"] }
          : {})}
        className="w-full justify-start"
        onPointerEnter={() => void commandMenu.load().catch(() => undefined)}
        onFocus={() => void commandMenu.load().catch(() => undefined)}
        onClick={() => setCommandOpen(true)}
      >
        {t("shell.chrome.search")}
      </Button>
      {props.create.length > 0 ? (
        <Button
          variant="ghost"
          icon="Plus"
          data-create-trigger=""
          {...(props.keys.display["create-menu"]
            ? { shortcut: props.keys.display["create-menu"] }
            : {})}
          className="w-full justify-start"
          onPointerEnter={() => void createMenu.load().catch(() => undefined)}
          onFocus={() => void createMenu.load().catch(() => undefined)}
          onClick={() => setCreateOpen(true)}
        >
          {t("shell.create.button")}
        </Button>
      ) : null}
      {props.workspaces.length > 0 ? (
        <Select
          id="workspace-filter"
          label={t("shell.chrome.workspace")}
          value={props.workspace ?? ""}
          options={[
            { value: "", label: t("shell.chrome.allWorkspaces") },
            ...props.workspaces.map((w) => ({ value: w.slug, label: w.name })),
          ]}
          onChange={async (event) => {
            await setWorkspace(event.target.value);
            router.refresh();
          }}
        />
      ) : null}
      <Sidebar
        label={t("nav.atlas.groups.chrome")}
        {...(active ? { active } : {})}
        groups={[{ items: nav.top.map(toItem) }]}
      />
      <section aria-labelledby="favorites-heading" className="px-8">
        <div className="flex items-center justify-between gap-8">
          <h2 id="favorites-heading" className="m-0 text-text-11 font-medium text-text-secondary">
            {t("nav.atlas.actions.favorites")}
          </h2>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              const peek = new URLSearchParams(window.location.search).get("peek");
              const result = await toggleFavoriteAction(org.slug, pathname, peek);
              setFavoriteError(result.error ? t(`settings.errors.${result.error}`) : null);
            }}
          >
            {props.favorites.some((f) => f.href.split("?")[0] === pathname)
              ? t("settings.favorites.unpin")
              : t("settings.favorites.pin")}
          </Button>
        </div>
        {favoriteError ? (
          <p role="alert" className="m-0 mt-4 text-text-12 text-danger-text">
            {favoriteError}
          </p>
        ) : null}
        {props.favorites.length === 0 ? (
          <p className="m-0 mt-4 text-text-12 text-text-tertiary">
            {t("shell.chrome.favoritesEmpty")}
          </p>
        ) : null}
      </section>
      {props.favorites.length > 0 ? (
        <Sidebar
          label={t("nav.atlas.actions.favorites")}
          {...(active ? { active } : {})}
          groups={[{ items: props.favorites.map(toItem) }]}
        />
      ) : null}
      <Sidebar
        label={t("shell.chrome.mainNav")}
        {...(active ? { active } : {})}
        groups={[
          { items: nav.pinned.map(toItem) },
          ...nav.groups.map((g) => ({
            label: g.label,
            collapsed: !g.expanded,
            items: g.items.map(toItem),
          })),
        ]}
      />
      <Sidebar
        label={t("nav.atlas.groups.footer")}
        {...(active ? { active } : {})}
        groups={[{ items: nav.footer.map(toItem) }]}
      />
    </>
  );

  return (
    <ShellKeysContext.Provider value={props.keys}>
      <div data-focus={focus ? "true" : undefined} className="xos-shell h-dvh">
        {/* Bypass blocks (2.4.1): the first stop skips the sidebar and header to the page (A23-011). */}
        <a
          href="#content"
          className="sr-only focus:not-sr-only focus:fixed focus:start-8 focus:top-8 focus:z-popover focus:rounded-control focus:bg-bg-raised focus:px-12 focus:py-8 focus:text-text-primary focus:shadow-menu"
        >
          {t("shell.page.skipToContent")}
        </a>
        {focus ? (
          <p className="sr-only" role="status">
            {t("shell.chrome.focusModeOn")}
          </p>
        ) : null}
        <AppShell
          menuOpen={menuOpen}
          onMenuOpenChange={setMenuOpen}
          brand={
            <ShellOrgSwitcher
              current={org.name}
              heading={t("shell.chrome.organizations")}
              orgs={props.orgs.map((o) => ({ name: o.name, role: o.role }))}
              onSelect={async (name) => {
                const target = props.orgs.find((o) => o.name === name);
                if (!target) return;
                const slug = await selectOrganization(target.slug);
                go(slug ? `/${slug}/home` : "/");
              }}
            />
          }
          sidebar={sidebar}
          header={
            <>
              <Breadcrumbs items={crumbs} />
              <AuroraCenter
                org={org.slug}
                canManage={props.canManageAi}
                shortcut={props.keys.display["aurora"]}
              />
              <HelpCenter org={org.slug} shortcut={props.keys.display["help"]} />
              <DeferredDropdownMenu
                label={t("shell.chrome.account")}
                icon="CircleUserRound"
                items={accountItems}
                compact
              />
            </>
          }
          mobileNav={
            <TabBar
              label={t("shell.chrome.mainNav")}
              active={active ?? ""}
              items={nav.bottomBar.map((item) => ({
                label: item.label,
                icon: item.icon,
                ...(item.href ? { href: item.href } : {}),
                onSelect: () => {
                  if (item.action === "search") setCommandOpen(true);
                  else if (item.action === "menu") setMenuOpen(true);
                  else if (item.href) go(item.href);
                },
              }))}
            />
          }
        >
          <div
            id="content"
            tabIndex={-1}
            className="flex min-w-0 flex-col gap-16 pb-(--xos-help-card-space) outline-none [&>*]:shrink-0"
          >
            <PreferencesProvider preferences={displayPreferences}>
              {props.children}
            </PreferencesProvider>
          </div>
        </AppShell>
        {command ? (
          <command.ShellCommand
            open={commandOpen}
            onOpenChange={setCommandOpen}
            commands={nav.commands}
            locale={props.locale}
            go={go}
          />
        ) : null}
        {create ? (
          <create.ShellCreate
            open={createOpen}
            onOpenChange={setCreateOpen}
            items={props.create}
            pathname={pathname}
            go={go}
          />
        ) : null}
        {pendingKey !== null && keyModule ? (
          <keyModule.GoHint keys={props.keys} prefix={pendingKey} />
        ) : null}
        <form
          ref={signOutForm}
          method="post"
          action="/auth/sign-out"
          onSubmit={() => broadcast("signed-out")}
          hidden
        />
        <SessionWatcher email={props.email} />
      </div>
    </ShellKeysContext.Provider>
  );
}
