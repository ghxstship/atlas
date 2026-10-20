"use client";

import {
  BrandMark,
  Button,
  CommandMenu,
  Dialog,
  Drawer,
  IconButton,
  Avatar,
  TabBar,
  TemplateGatewayShell,
  TopNav,
  type NavItem,
} from "@xos/ui";
import type { Route } from "next";
import NextLink from "next/link";
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
import { HelpEntry } from "@/components/help/help-entry";
import { setActing, setLocale, setTheme } from "@/lib/shell/actions";
import type { ThemePreference } from "@/lib/theme";
import { broadcast, SessionWatcher } from "./session-watcher";

export interface FrameLink {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly icon: string;
}

export interface FrameAvatarEntry {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly href?: string;
  readonly action?: "switch-org" | "help" | "sign-out";
}

export interface GatewayFrameProps {
  readonly brandName: string;
  readonly showPoweredBy: boolean;
  readonly primary: readonly FrameLink[];
  readonly bottomBar: readonly FrameLink[];
  readonly avatar: readonly FrameAvatarEntry[];
  readonly commands: readonly FrameLink[];
  readonly personName: string;
  readonly email: string | null;
  readonly accounts: readonly {
    readonly id: string;
    readonly name: string;
    readonly role: string;
  }[];
  readonly actingId: string | null;
  readonly orgs: readonly { readonly id: string; readonly name: string }[];
  readonly theme: ThemePreference;
  readonly locale: string;
  readonly locales: readonly string[];
  /** The docs site origin (DOCS_SITE_URL), on the platform brand only; null hides its links. */
  readonly docsUrl: string | null;
  readonly children: ReactNode;
}

type Translate = (key: string, values?: Record<string, string>) => string;

/** Whether a path sits under a destination; the longest match wins. */
function activeLabel(links: readonly FrameLink[], pathname: string): string {
  const match = links
    .filter((l) => pathname === l.href || pathname.startsWith(`${l.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return match?.label ?? "";
}

/**
 * The Gateway shell (Section 11.6, Gateway shell; Section 4.5.8): the org or platform brand, the five
 * destinations in the top bar on desktop and the bottom tab bar on phones, search (Cmd or Ctrl+K),
 * help (the Help button, the avatar menu's Help and the `?` key open the contextual help panel,
 * Section 11.16), and the account panel with the avatar menu, the acting account, theme and
 * language. Every destination comes from ia/sitemap.yaml through the server-built navigation model.
 */
export function GatewayFrame(props: GatewayFrameProps) {
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations() as unknown as Translate;
  const [commandOpen, setCommandOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);
  const signOutForm = useRef<HTMLFormElement>(null);

  const go = useCallback((href: string) => router.push(href as Route), [router]);

  const toItem = useCallback(
    (l: FrameLink): NavItem & { icon: string } => ({
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

  const active = useMemo(() => activeLabel(props.primary, pathname), [props.primary, pathname]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "");
      if (event.key === "?" && !typing && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        setHelpOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const runAvatar = (entry: FrameAvatarEntry) => {
    setAccountOpen(false);
    if (entry.action === "sign-out") {
      broadcast("signed-out");
      signOutForm.current?.requestSubmit();
    } else if (entry.action === "help") setHelpOpen(true);
    else if (entry.action === "switch-org") setSwitchOpen(true);
    else if (entry.href) go(entry.href);
  };

  const refresh = () => {
    broadcast("preferences");
    router.refresh();
  };

  const brand = (
    <NextLink
      href={"/home" as Route}
      aria-label={t("gateway.shell.brandHome", { name: props.brandName })}
      className="inline-flex items-center no-underline text-text-primary"
    >
      <BrandMark name={props.brandName} size="sm" />
    </NextLink>
  );

  const topNav = (
    <TopNav
      brand={props.brandName}
      label={t("gateway.shell.primaryNav")}
      person={props.personName}
      active={active}
      items={props.primary.map(toItem)}
      onSearch={() => setCommandOpen(true)}
      onHelp={() => setHelpOpen(true)}
      onAccount={() => setAccountOpen(true)}
    />
  );

  const mobileHeader = (
    <header className="hidden max-md:flex items-center justify-between gap-8 h-(--ui-topnav) px-16 bg-bg-surface border-b border-border-subtle">
      {brand}
      <div className="flex items-center gap-4">
        <IconButton
          icon="Search"
          label={t("gateway.shell.search")}
          onClick={() => setCommandOpen(true)}
        />
        <button
          type="button"
          aria-haspopup="dialog"
          aria-label={t("gateway.shell.openAccount", { name: props.personName })}
          onClick={() => setAccountOpen(true)}
          className="xos-hit grid place-items-center min-h-touch-min min-w-touch-min p-0 rounded-full border-0 bg-transparent cursor-pointer"
        >
          <span aria-hidden="true" className="contents">
            <Avatar name={props.personName} />
          </span>
        </button>
      </div>
    </header>
  );

  return (
    <div className="flex min-h-dvh flex-col max-md:h-dvh">
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:fixed focus:start-8 focus:top-8 focus:z-50 focus:rounded-control focus:bg-bg-raised focus:px-12 focus:py-8"
      >
        {t("gateway.shell.skip")}
      </a>
      {mobileHeader}
      <TemplateGatewayShell
        topNav={topNav}
        tabBar={
          <TabBar
            label={t("gateway.shell.primaryNav")}
            active={active}
            items={props.bottomBar.map(toItem)}
          />
        }
      >
        <div id="content" className="flex flex-col gap-16 min-w-0">
          {props.children}
        </div>
        {props.showPoweredBy ? (
          <p className="m-0 pt-24 text-center text-text-12 text-text-tertiary">
            {t("gateway.shell.poweredBy")}
          </p>
        ) : null}
      </TemplateGatewayShell>

      <CommandMenu
        open={commandOpen}
        onOpenChange={setCommandOpen}
        placeholder={t("gateway.shell.searchHint")}
        groups={[
          {
            label: t("gateway.shell.commandGroup"),
            items: props.commands.map((c) => ({
              label: c.label,
              icon: c.icon,
              onSelect: () => {
                setCommandOpen(false);
                go(c.href);
              },
            })),
          },
        ]}
      />

      <Drawer
        open={accountOpen}
        onOpenChange={setAccountOpen}
        title={props.personName}
        onClose={() => setAccountOpen(false)}
      >
        <div className="flex flex-col gap-16">
          {props.email ? (
            <p className="m-0 text-text-13 text-text-secondary">{props.email}</p>
          ) : null}
          <ul className="m-0 flex list-none flex-col p-0">
            {props.avatar.map((entry) => (
              <li key={entry.id}>
                <Button
                  variant="ghost"
                  icon={entry.icon}
                  className="w-full justify-start"
                  onClick={() => runAvatar(entry)}
                >
                  {entry.label}
                </Button>
              </li>
            ))}
          </ul>
          {props.accounts.length > 0 ? (
            <fieldset className="m-0 flex flex-col gap-4 border-0 p-0">
              <legend className="mb-4 text-text-12 font-medium text-text-secondary">
                {t("gateway.shell.actingAs")}
              </legend>
              {[
                {
                  id: "self",
                  name: t("gateway.shell.actSelf"),
                  role: t("gateway.shell.actSelfHint"),
                },
                ...props.accounts,
              ].map((a) => {
                const current = (props.actingId ?? "self") === a.id;
                return (
                  <Button
                    key={a.id}
                    variant={current ? "secondary" : "ghost"}
                    aria-pressed={current}
                    className="w-full justify-between"
                    onClick={async () => {
                      await setActing(a.id);
                      setAccountOpen(false);
                      refresh();
                      go("/home");
                    }}
                  >
                    <span>{a.name}</span>
                    <span className="text-text-12 text-text-secondary">{a.role}</span>
                  </Button>
                );
              })}
            </fieldset>
          ) : null}
          <fieldset className="m-0 flex flex-col gap-4 border-0 p-0">
            <legend className="mb-4 text-text-12 font-medium text-text-secondary">
              {t("gateway.shell.theme")}
            </legend>
            <div className="flex flex-wrap gap-4">
              {(["system", "dark", "light"] as const).map((pref) => (
                <Button
                  key={pref}
                  size="sm"
                  variant={props.theme === pref ? "secondary" : "ghost"}
                  aria-pressed={props.theme === pref}
                  onClick={async () => {
                    await setTheme(pref);
                    refresh();
                  }}
                >
                  {t(`gateway.shell.theme${pref.charAt(0).toUpperCase()}${pref.slice(1)}`)}
                </Button>
              ))}
            </div>
          </fieldset>
          <fieldset className="m-0 flex flex-col gap-4 border-0 p-0">
            <legend className="mb-4 text-text-12 font-medium text-text-secondary">
              {t("gateway.shell.language")}
            </legend>
            <div className="flex flex-wrap gap-4">
              {props.locales.map((l) => (
                <Button
                  key={l}
                  size="sm"
                  variant={props.locale === l ? "secondary" : "ghost"}
                  aria-pressed={props.locale === l}
                  onClick={async () => {
                    await setLocale(l);
                    refresh();
                  }}
                >
                  {t(`gateway.shell.locales.${l}`)}
                </Button>
              ))}
            </div>
          </fieldset>
        </div>
      </Drawer>

      <HelpEntry open={helpOpen} onOpenChange={setHelpOpen} docsUrl={props.docsUrl} />

      <Dialog
        open={switchOpen}
        onOpenChange={setSwitchOpen}
        title={t("gateway.shell.switchOrg.title")}
        description={
          props.orgs.length > 0
            ? t("gateway.shell.switchOrg.body")
            : t("gateway.shell.switchOrg.empty")
        }
        actions={
          <Button
            variant="primary"
            onClick={() => {
              setSwitchOpen(false);
              go(props.orgs.length > 0 ? "/work/engagements" : "/explore");
            }}
          >
            {t("gateway.shell.switchOrg.all")}
          </Button>
        }
      >
        <ul className="m-0 flex list-none flex-col p-0">
          {props.orgs.map((o) => (
            <li key={o.id}>
              <Button
                variant="ghost"
                className="w-full justify-start"
                onClick={() => {
                  setSwitchOpen(false);
                  go(`/work/engagements?org=${o.id}`);
                }}
              >
                {o.name}
              </Button>
            </li>
          ))}
        </ul>
      </Dialog>

      <form ref={signOutForm} method="post" action="/auth/sign-out" className="hidden" />
      <SessionWatcher email={props.email} />
    </div>
  );
}
