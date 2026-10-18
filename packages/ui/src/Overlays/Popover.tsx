import { type ReactElement } from "react";
import { Popover as RPopover } from "radix-ui";
import type { PopoverProps as ReferencePopoverProps } from "../types/reference";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { linkClass } from "../Link/Link.tsx";
import { type PopoverProps } from "./Overlays.types.ts";
import { popoverPanelClass } from "./popoverPanelClass.tsx";

function PopoverBody({ title, children, learnMore }: ReferencePopoverProps) {
  const t = useT();
  return (
    <>
      {title ? <strong className="font-semibold">{title}</strong> : null}
      <div className="text-text-secondary">{children}</div>
      {learnMore ? (
        <a className={linkClass} href={learnMore}>
          {t("help.learnMore")}
          <Icon name="ArrowUpRight" size={12} />
        </a>
      ) : null}
    </>
  );
}

const popoverClass = cx(popoverPanelClass, "flex flex-col gap-8 p-12 w-(--ui-popover) z-popover");

/** More than one sentence of help, with a Learn more link. Esc and outside clicks close it. */
export function Popover({
  title,
  children,
  learnMore,
  open,
  defaultOpen,
  onOpenChange,
  trigger,
}: PopoverProps): ReactElement {
  const body = (
    <PopoverBody {...(title ? { title } : {})} {...(learnMore ? { learnMore } : {})}>
      {children}
    </PopoverBody>
  );
  if (trigger === undefined) {
    return (
      <div role="group" aria-label={title} className={popoverClass}>
        {body}
      </div>
    );
  }
  return (
    <RPopover.Root
      {...(open === undefined ? {} : { open })}
      {...(defaultOpen === undefined ? {} : { defaultOpen })}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      <RPopover.Trigger asChild>{trigger}</RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content
          sideOffset={4}
          collisionPadding={16}
          aria-label={title}
          className={popoverClass}
        >
          {body}
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  );
}
