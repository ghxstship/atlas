import type { ReactElement } from "react";
import { DropdownMenu as RDropdownMenu } from "radix-ui";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Badge } from "../Chips/Chips.tsx";
import { BrandMark } from "../BrandMark/BrandMark.tsx";
import { headClass, sepClass } from "./Menus.shared.tsx";
import { type OrgSwitcherProps } from "./Menus.types.ts";
import { menuClass } from "./menuClass.tsx";
import { menuItemClass } from "./menuItemClass.tsx";
import { orgSwitcherTriggerClass } from "./orgSwitcherTriggerClass.tsx";

/** Moves between every org a person works with; the marketplace sits at the bottom. */
export function OrgSwitcher({
  current,
  heading,
  orgs,
  onSelect,
  onMarketplace,
  defaultOpen,
}: OrgSwitcherProps): ReactElement {
  const t = useT();
  return (
    <RDropdownMenu.Root {...(defaultOpen === undefined ? {} : { defaultOpen })} modal={false}>
      <RDropdownMenu.Trigger aria-label={current} className={orgSwitcherTriggerClass}>
        <BrandMark name={current} size="sm" />
        <Icon name="ChevronsUpDown" size={14} color="var(--color-text-secondary)" />
      </RDropdownMenu.Trigger>
      <RDropdownMenu.Portal>
        <RDropdownMenu.Content
          className={cx(menuClass, "w-(--ui-orgsw)")}
          sideOffset={4}
          align="start"
          collisionPadding={16}
        >
          <RDropdownMenu.Label className={headClass}>{heading}</RDropdownMenu.Label>
          <RDropdownMenu.RadioGroup value={current} onValueChange={(name) => onSelect?.(name)}>
            {orgs.map((o) => (
              <RDropdownMenu.RadioItem
                key={o.name}
                value={o.name}
                className={cx(menuItemClass, "h-row-comfortable")}
              >
                <BrandMark name={o.name} size="sm" iconOnly />
                <span className="flex flex-1 flex-col">
                  <span>{o.name}</span>
                  <span className="text-text-12 text-text-secondary">{o.role}</span>
                </span>
                <RDropdownMenu.ItemIndicator>
                  <Icon name="Check" size={14} />
                </RDropdownMenu.ItemIndicator>
                {o.name !== current && o.badge ? <Badge count={o.badge} tone="accent" /> : null}
              </RDropdownMenu.RadioItem>
            ))}
          </RDropdownMenu.RadioGroup>
          <RDropdownMenu.Separator className={sepClass} />
          <RDropdownMenu.Item
            className={menuItemClass}
            {...(onMarketplace ? { onSelect: onMarketplace } : {})}
          >
            <Icon name="Compass" />
            <span>{t("org.marketplace")}</span>
          </RDropdownMenu.Item>
        </RDropdownMenu.Content>
      </RDropdownMenu.Portal>
    </RDropdownMenu.Root>
  );
}
