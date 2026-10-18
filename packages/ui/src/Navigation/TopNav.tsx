import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { IconButton } from "../Button/Button.tsx";
import { Badge } from "../Chips/Chips.tsx";
import { Avatar } from "../Avatar/Avatar.tsx";
import { BrandMark } from "../BrandMark/BrandMark.tsx";
import { ItemAction } from "./Navigation.shared.tsx";
import { type TopNavProps } from "./Navigation.types.ts";

/** The Gateway top bar on desktop: brand, the five destinations, search, help and the account menu. */
export function TopNav({
  brand,
  label,
  person,
  active,
  items,
  onSearch,
  onHelp,
  onAccount,
}: TopNavProps): ReactElement {
  const t = useT();
  return (
    <header
      className={cx(
        "flex items-center justify-between gap-16 h-(--ui-topnav) px-20 max-lg:px-16 bg-bg-surface border-b border-border-subtle",
        "print:hidden",
      )}
    >
      <div className="flex items-center gap-24 max-lg:gap-12 min-w-0">
        <span className="max-lg:[&_[aria-hidden]+[aria-hidden]]:hidden">
          <BrandMark name={brand} size="sm" />
        </span>
        <nav
          aria-label={label}
          className="min-w-0 overflow-x-auto max-md:hidden [scrollbar-width:none]"
        >
          <ul className="flex gap-4 m-0 p-0 list-none">
            {items.map((item) => (
              <li key={item.label}>
                <ItemAction
                  item={item}
                  active={item.label === active}
                  className={cx(
                    "inline-flex items-center gap-6 h-row-default px-12 max-lg:px-8 rounded-control no-underline",
                    "font-medium text-text-14 text-text-secondary hover:bg-bg-hover hover:text-text-primary",
                    "aria-[current=page]:bg-bg-hover aria-[current=page]:text-text-primary",
                    "pointer-coarse:min-h-target-coarse pointer-coarse:min-w-target-coarse",
                  )}
                >
                  <Icon name={item.icon} size={16} />
                  {item.label}
                  {item.badge ? (
                    <Badge
                      count={item.badge}
                      tone="accent"
                      label={t("tabbar.badge", { n: item.badge })}
                    />
                  ) : null}
                </ItemAction>
              </li>
            ))}
          </ul>
        </nav>
      </div>
      <div className="flex flex-none items-center gap-8">
        <IconButton icon="Search" label={t("command.label")} shortcut="⌘ K" onClick={onSearch} />
        <IconButton icon="CircleHelp" label={t("help.title")} shortcut="?" onClick={onHelp} />
        <button
          type="button"
          aria-haspopup="menu"
          aria-label={t("nav.account", { name: person })}
          onClick={onAccount}
          className="xos-hit grid place-items-center size-(--ui-avatar-lg) p-0 rounded-full border-0 bg-transparent cursor-pointer"
        >
          <span aria-hidden="true" className="contents">
            <Avatar name={person} />
          </span>
        </button>
      </div>
    </header>
  );
}
