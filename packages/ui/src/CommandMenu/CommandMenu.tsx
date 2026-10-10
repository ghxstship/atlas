import type { ReactElement } from "react";
import { Command } from "cmdk";
import { Dialog as RDialog } from "radix-ui";
import type {
  CommandMenuProps as ReferenceCommandMenuProps,
  IconName,
  RecordState,
} from "../types/reference";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { useControllable, useHotkey } from "../lib/hooks.ts";
import { Icon } from "../Icon/Icon.tsx";
import { Kbd, Keys } from "../Kbd/Kbd.tsx";
import { StateIcon } from "../StateIcon/StateIcon.tsx";
import { panelClass } from "../Overlays/Overlays.tsx";

export interface CommandItem {
  label: string;
  code?: string;
  icon?: IconName;
  state?: RecordState;
  shortcut?: string;
  selected?: boolean;
  onSelect?: () => void;
}

export type CommandMenuProps = Omit<ReferenceCommandMenuProps, "groups"> & {
  groups: { label: string; items: CommandItem[] }[];
  /** Called as the search text changes, for server-side results. */
  onQueryChange?: (query: string) => void;
  /** Dialog mode: the menu opens over the page. Omit `open` to render the palette inline. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** In dialog mode, Cmd or Ctrl+K toggles the menu (on by default). */
  hotkey?: boolean;
  /** Turn off client filtering when the results come from a server search. */
  filter?: boolean;
};

function itemValue(group: string, item: CommandItem): string {
  return `${group} ${item.label} ${item.code ?? ""}`.trim();
}

function Palette({
  query,
  placeholder: hint,
  groups,
  onQueryChange,
  filter = true,
  onClose,
}: CommandMenuProps & { onClose?: () => void }) {
  const t = useT();
  const [search, setSearch] = useControllable<string>(undefined, query ?? "", onQueryChange);
  const selected = groups.flatMap((g) =>
    g.items.filter((i) => i.selected).map((i) => itemValue(g.label, i)),
  )[0];
  return (
    <Command
      label={t("command.label")}
      shouldFilter={filter}
      loop
      {...(selected ? { defaultValue: selected } : {})}
      className={cx(panelClass, "xos-anim-dialog w-(--ui-command) overflow-hidden")}
    >
      <div className="flex items-center gap-8 h-(--ui-cmd-input) px-16 border-b border-border-subtle text-text-14">
        <Icon name="search" color="var(--color-text-secondary)" />
        <Command.Input
          value={search}
          onValueChange={setSearch}
          placeholder={hint}
          className="flex-1 min-w-0 bg-transparent border-0 outline-none text-text-primary placeholder:text-text-tertiary"
        />
        <Kbd>{t("key.esc")}</Kbd>
      </div>
      <Command.Empty className="px-16 py-12 text-text-secondary">{t("list.noMatch")}</Command.Empty>
      <Command.List
        label={t("command.results")}
        className="max-h-(--ui-listbox-max) overflow-y-auto p-8 pt-4"
      >
        {groups.map((g) => (
          <Command.Group
            key={g.label}
            heading={g.label}
            className="[&_[cmdk-group-heading]]:mx-8 [&_[cmdk-group-heading]]:mt-8 [&_[cmdk-group-heading]]:mb-4 [&_[cmdk-group-heading]]:text-text-11 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-text-secondary"
          >
            {g.items.map((item) => (
              <Command.Item
                key={itemValue(g.label, item)}
                value={itemValue(g.label, item)}
                onSelect={() => {
                  item.onSelect?.();
                  onClose?.();
                }}
                className={cx(
                  "flex items-center gap-8 h-row-default px-8 rounded-control text-text-primary cursor-pointer",
                  "data-[selected=true]:bg-bg-hover pointer-coarse:min-h-target-coarse [&_svg]:text-text-secondary",
                )}
              >
                {item.state ? (
                  <StateIcon state={item.state} />
                ) : (
                  <Icon name={item.icon ?? "chevron-right"} />
                )}
                <span>{item.label}</span>
                {item.code ? (
                  <span className="font-mono text-text-12 text-text-secondary">{item.code}</span>
                ) : null}
                {item.shortcut ? (
                  <span className="ms-auto">
                    <Keys keys={item.shortcut} />
                  </span>
                ) : null}
              </Command.Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
    </Command>
  );
}

/**
 * Finds records, people, pages, settings and actions. Inline by default; with `open` it is a dialog
 * that Cmd or Ctrl+K toggles. Arrow keys move, Enter runs, Esc closes.
 */
export function CommandMenu({
  open,
  onOpenChange,
  hotkey = true,
  ...props
}: CommandMenuProps): ReactElement {
  const t = useT();
  const dialog = open !== undefined;
  const [isOpen, setOpen] = useControllable(open, false, onOpenChange);
  useHotkey("k", () => setOpen(!isOpen), { mod: true, enabled: dialog && hotkey });
  if (!dialog) return <Palette {...props} />;
  return (
    <RDialog.Root open={isOpen} onOpenChange={setOpen}>
      <RDialog.Portal>
        <RDialog.Overlay className="xos-anim-fade fixed inset-0 z-command bg-scrim opacity-scrim-dark in-data-[theme=light]:opacity-scrim-light in-data-[theme=sunlight]:opacity-scrim-light" />
        <div className="pointer-events-none fixed inset-0 z-command flex justify-center px-16 pt-64">
          <RDialog.Content
            aria-describedby={undefined}
            className="pointer-events-auto h-fit max-w-full"
          >
            <RDialog.Title className="sr-only">{t("command.label")}</RDialog.Title>
            <Palette {...props} onClose={() => setOpen(false)} />
          </RDialog.Content>
        </div>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
