import type { ReactElement } from "react";
import { DropdownMenu as RDropdownMenu } from "radix-ui";
import { Icon } from "../Icon/Icon.tsx";
import { buttonClass } from "../Button/Button.tsx";
import { renderItems } from "./Menus.shared.tsx";
import { type DropdownMenuProps } from "./Menus.types.ts";
import { menuClass } from "./menuClass.tsx";
import { compactChevronClass, compactLabelClass } from "./compactTriggerClass.tsx";

/** A short list of actions from a button. Arrow keys move, typing jumps, Enter selects, Esc closes. */
export function DropdownMenu({
  label,
  icon,
  items,
  defaultOpen,
  open,
  onOpenChange,
  compact = false,
}: DropdownMenuProps): ReactElement {
  const short = compact && icon !== undefined;
  return (
    <RDropdownMenu.Root
      {...(defaultOpen === undefined ? {} : { defaultOpen })}
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange ? { onOpenChange } : {})}
      modal={false}
    >
      <RDropdownMenu.Trigger className={buttonClass()}>
        {icon ? <Icon name={icon} size={14} /> : null}
        {short ? <span className={compactLabelClass}>{label}</span> : label}
        {short ? (
          <span className={compactChevronClass}>
            <Icon name="ChevronDown" size={14} />
          </span>
        ) : (
          <Icon name="ChevronDown" size={14} />
        )}
      </RDropdownMenu.Trigger>
      <RDropdownMenu.Portal>
        <RDropdownMenu.Content
          className={menuClass}
          sideOffset={4}
          align="start"
          collisionPadding={16}
        >
          {renderItems(RDropdownMenu, items)}
        </RDropdownMenu.Content>
      </RDropdownMenu.Portal>
    </RDropdownMenu.Root>
  );
}
