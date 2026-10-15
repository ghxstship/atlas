"use client";

import { resolveBreadcrumbs } from "@xos/ia";
import {
  AppShell,
  Breadcrumbs,
  Button,
  CommandMenu,
  DropdownMenu,
  OrgSwitcher,
  Select,
  Sidebar,
  TabBar,
  type MenuItem,
  type NavItem,
} from "@xos/ui";
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
import { sitemap } from "@/ia/sitemap.generated";
import type { AtlasLocale } from "@/i18n/negotiate";
import type { NavLinkModel, ShellNav } from "@/lib/shell/nav-model";
import { selectOrganization, setLocale, setTheme, setWorkspace } from "@/lib/shell/actions";
import { toggleFavoriteAction } from "@/lib/settings/favorites-actions";
import type { Theme } from "@/lib/theme";
import { HelpCenter, helpCommandItems, openHelpArticle } from "@/components/help/help-center";
import { broadcast, SessionWatcher } from "./session-watcher";

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
  readonly children: ReactNode;
}

type Translate = (key: string, values?: Record<string, string>) => string;

/**
 * The Atlas shell on @xos/ui (A05): org switcher, workspace filter, sitemap sidebar with favorites
 * and role-default groups, breadcrumbs, account menu, command menu (Cmd or Ctrl+K, and `/`), the
 * phone bottom bar, focus mode (Cmd or Ctrl+.) and the session dialog. Every item comes from the
 * navigation model built from ia/sitemap.yaml on the server.
 */
export function ShellFrame(props: ShellFrameProps) {
  const { org, nav } = props;
  const router = useRouter();
  const pathname = usePathname();
  const tRoot = useTranslations();
  const t = tRoot as unknown as Translate;
  const [commandOpen, setCommandOpen] = useState(false);
  const [focus, setFocus] = useState(false);
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "");
      if ((event.metaKey || event.ctrlKey) && event.key === ".") {
        event.preventDefault();
        setFocus((f) => !f);
      } else if (event.key === "/" && !typing && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        setCommandOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const workspaceName = props.workspaces.find((w) => w.slug === props.workspace)?.name;
  const crumbs = resolveBreadcrumbs(
    sitemap,
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
    { label: t("shell.chrome.focusMode"), shortcut: "Mod+.", onSelect: () => setFocus(true) },
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
        shortcut="Mod+K"
        className="w-full justify-start"
        onClick={() => setCommandOpen(true)}
      >
        {t("shell.chrome.search")}
      </Button>
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
        label={t("ui.nav.main")}
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
    <div data-focus={focus ? "true" : undefined} className="xos-shell h-dvh">
      {focus ? (
        <p className="sr-only" role="status">
          {t("shell.chrome.focusModeOn")}
        </p>
      ) : null}
      <AppShell
        brand={
          <OrgSwitcher
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
            <HelpCenter org={org.slug} />
            <DropdownMenu
              label={t("shell.chrome.account")}
              icon="CircleUserRound"
              items={accountItems}
            />
          </>
        }
        mobileNav={
          <TabBar
            label={t("ui.nav.main")}
            active={active ?? ""}
            items={nav.bottomBar.map((item) => ({
              label: item.label,
              icon: item.icon,
              ...(item.href ? { href: item.href } : {}),
              onSelect: () => {
                if (item.action === "search") setCommandOpen(true);
                else if (item.action === "menu") {
                  document
                    .querySelector<HTMLButtonElement>("button[aria-controls][aria-expanded]")
                    ?.click();
                } else if (item.href) go(item.href);
              },
            }))}
          />
        }
      >
        {props.children}
      </AppShell>
      <CommandMenu
        open={commandOpen}
        onOpenChange={setCommandOpen}
        placeholder={t("shell.chrome.searchHint")}
        groups={[
          ...nav.commands.map((g) => ({
            label: g.label,
            items: g.items.map((item) => ({
              label: item.label,
              icon: item.icon,
              onSelect: () => {
                setCommandOpen(false);
                go(item.href);
              },
            })),
          })),
          {
            label: t("help.title"),
            items: helpCommandItems(props.locale).map((a) => ({
              label: a.title,
              icon: "BookOpen",
              onSelect: () => {
                setCommandOpen(false);
                openHelpArticle(a.slug);
              },
            })),
          },
        ]}
      />
      <form
        ref={signOutForm}
        method="post"
        action="/auth/sign-out"
        onSubmit={() => broadcast("signed-out")}
        hidden
      />
      <SessionWatcher email={props.email} />
    </div>
  );
}
