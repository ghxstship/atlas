"use client";

import { Button, CommandMenu, Dialog, Drawer } from "@xos/ui";
import { isBetaLocale } from "@xos/i18n/locales";
import { useTranslations } from "next-intl";
import { setActing, setLocale, setTheme } from "@/lib/shell/actions";
import type { ThemePreference } from "@/lib/theme";
import type { FrameAvatarEntry, FrameLink } from "./gateway-frame";

type Translate = (key: string, values?: Record<string, string>) => string;

export interface ShellOverlaysProps {
  readonly commandOpen: boolean;
  readonly setCommandOpen: (open: boolean) => void;
  readonly accountOpen: boolean;
  readonly setAccountOpen: (open: boolean) => void;
  readonly switchOpen: boolean;
  readonly setSwitchOpen: (open: boolean) => void;
  readonly commands: readonly FrameLink[];
  readonly personName: string;
  readonly email: string | null;
  readonly avatar: readonly FrameAvatarEntry[];
  readonly runAvatar: (entry: FrameAvatarEntry) => void;
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
  readonly go: (href: string) => void;
  readonly refresh: () => void;
}

/**
 * The Gateway shell's overlays: search (the command menu), the account panel and the organization
 * switcher. They render nothing until opened, so they load the first time one opens
 * (A24-009, ADR 0027): cmdk and the Radix dialog stay out of every page's JavaScript. The frame
 * keeps the open state and the shortcuts.
 */
export function ShellOverlays(props: ShellOverlaysProps) {
  const t = useTranslations() as unknown as Translate;
  const { go, refresh } = props;
  return (
    <>
      <CommandMenu
        open={props.commandOpen}
        onOpenChange={props.setCommandOpen}
        hotkey={false}
        placeholder={t("gateway.shell.searchHint")}
        groups={[
          {
            label: t("gateway.shell.commandGroup"),
            items: props.commands.map((c) => ({
              label: c.label,
              icon: c.icon,
              onSelect: () => {
                props.setCommandOpen(false);
                go(c.href);
              },
            })),
          },
        ]}
      />

      <Drawer
        open={props.accountOpen}
        onOpenChange={props.setAccountOpen}
        title={props.personName}
        onClose={() => props.setAccountOpen(false)}
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
                  onClick={() => props.runAvatar(entry)}
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
                      props.setAccountOpen(false);
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
                  {/* A Beta locale (Section 15) says so in its name, so screen readers announce it too. */}
                  {isBetaLocale(l)
                    ? t("gateway.shell.betaLocale", { language: t(`gateway.shell.locales.${l}`) })
                    : t(`gateway.shell.locales.${l}`)}
                </Button>
              ))}
            </div>
          </fieldset>
        </div>
      </Drawer>

      <Dialog
        open={props.switchOpen}
        onOpenChange={props.setSwitchOpen}
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
              props.setSwitchOpen(false);
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
                  props.setSwitchOpen(false);
                  go(`/work/engagements?org=${o.id}`);
                }}
              >
                {o.name}
              </Button>
            </li>
          ))}
        </ul>
      </Dialog>
    </>
  );
}
