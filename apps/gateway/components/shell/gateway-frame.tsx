"use client";

import {
  BrandMark,
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
import type { ThemePreference } from "@/lib/theme";
import { onDemand, useOnDemand } from "./on-demand";
import { broadcast, SessionWatcher } from "./session-watcher";

/** Search, the account panel and the organization switcher load when one first opens. */
const overlays = onDemand(() => import("./shell-overlays"));
const preloadOverlays = () => void overlays.load().catch(() => undefined);

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
 * Search, the account panel and the organization switcher (shell-overlays.tsx) load on first use;
 * pointing at or focusing the header fetches them early. Help loads its own panel (HelpEntry).
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
  const loaded = useOnDemand(overlays, commandOpen || accountOpen || switchOpen);

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
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        // The command menu's own Cmd or Ctrl+K arrives with its module, so the frame owns it.
        event.preventDefault();
        setCommandOpen((open) => !open);
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
    <div className="contents" onPointerOver={preloadOverlays} onFocus={preloadOverlays}>
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
    </div>
  );

  const mobileHeader = (
    <header
      className="hidden max-md:flex items-center justify-between gap-8 h-(--ui-topnav) px-16 bg-bg-surface border-b border-border-subtle"
      onPointerOver={preloadOverlays}
      onFocus={preloadOverlays}
    >
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

      {loaded ? (
        <loaded.ShellOverlays
          commandOpen={commandOpen}
          setCommandOpen={setCommandOpen}
          accountOpen={accountOpen}
          setAccountOpen={setAccountOpen}
          switchOpen={switchOpen}
          setSwitchOpen={setSwitchOpen}
          commands={props.commands}
          personName={props.personName}
          email={props.email}
          avatar={props.avatar}
          runAvatar={runAvatar}
          accounts={props.accounts}
          actingId={props.actingId}
          orgs={props.orgs}
          theme={props.theme}
          locale={props.locale}
          locales={props.locales}
          go={go}
          refresh={refresh}
        />
      ) : null}

      <HelpEntry open={helpOpen} onOpenChange={setHelpOpen} docsUrl={props.docsUrl} />

      <form ref={signOutForm} method="post" action="/auth/sign-out" className="hidden" />
      <SessionWatcher email={props.email} />
    </div>
  );
}
