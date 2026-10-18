import { type ReactElement } from "react";
import { Dialog as RDialog } from "radix-ui";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { useReturnFocus } from "../lib/hooks.ts";
import { IconButton } from "../Button/Button.tsx";
import { scrimClass, useOverlayOpen } from "./Overlays.shared.tsx";
import { type DrawerProps } from "./Overlays.types.ts";
import { panelClass } from "./panelClass.tsx";

/** Slides in from an edge for secondary tasks; full screen below md. */
export function Drawer({
  title,
  side = "right",
  children,
  footer,
  onClose,
  ...control
}: DrawerProps): ReactElement {
  const t = useT();
  const [isOpen, setOpen] = useOverlayOpen(control);
  const returnFocus = useReturnFocus(isOpen);
  const change = (next: boolean) => {
    setOpen(next);
    if (!next) onClose?.();
  };
  return (
    <RDialog.Root open={isOpen} onOpenChange={change}>
      {control.trigger ? <RDialog.Trigger asChild>{control.trigger}</RDialog.Trigger> : null}
      <RDialog.Portal>
        <RDialog.Overlay className={scrimClass} />
        <RDialog.Content
          onCloseAutoFocus={returnFocus}
          aria-describedby={undefined}
          className={cx(
            panelClass,
            "xos-anim-peek fixed inset-y-0 z-dialog flex flex-col w-(--ui-drawer) rounded-none",
            "max-md:w-full",
            side === "left" ? "start-0" : "end-0",
          )}
        >
          <header className="flex items-center justify-between py-8 ps-20 pe-12 border-b border-border-subtle">
            <RDialog.Title className="m-0 text-text-13 font-semibold">{title}</RDialog.Title>
            <RDialog.Close asChild>
              <IconButton icon="X" label={t("action.close")} shortcut={t("key.esc")} />
            </RDialog.Close>
          </header>
          <div className="flex flex-1 flex-col gap-16 p-20 overflow-y-auto">{children}</div>
          {footer ? (
            <footer className="flex justify-end gap-8 px-20 py-12 border-t border-border-subtle">
              {footer}
            </footer>
          ) : null}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
