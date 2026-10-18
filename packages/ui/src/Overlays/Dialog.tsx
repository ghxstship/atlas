import { type ReactElement } from "react";
import { Dialog as RDialog } from "radix-ui";
import { cx } from "../lib/cx.ts";
import { useReturnFocus } from "../lib/hooks.ts";
import { scrimClass, useOverlayOpen } from "./Overlays.shared.tsx";
import { type DialogProps } from "./Overlays.types.ts";
import { panelClass } from "./panelClass.tsx";

/** For irreversible actions only; everything else uses Undo. Focus is trapped and Esc closes. */
export function Dialog({
  title,
  children,
  actions,
  description,
  ...control
}: DialogProps): ReactElement {
  const [isOpen, setOpen] = useOverlayOpen(control);
  const returnFocus = useReturnFocus(isOpen);
  return (
    <RDialog.Root open={isOpen} onOpenChange={setOpen}>
      {control.trigger ? <RDialog.Trigger asChild>{control.trigger}</RDialog.Trigger> : null}
      <RDialog.Portal>
        <RDialog.Overlay className={scrimClass} />
        <div className="pointer-events-none fixed inset-0 z-dialog grid place-items-center p-16">
          <RDialog.Content
            onCloseAutoFocus={returnFocus}
            className={cx(
              panelClass,
              "xos-anim-dialog pointer-events-auto w-(--ui-dialog) flex flex-col max-h-full",
            )}
            {...(description ? {} : { "aria-describedby": undefined })}
          >
            <header className="shrink-0 px-20 pt-20">
              <RDialog.Title className="m-0 text-heading-16 font-semibold">{title}</RDialog.Title>
              {description ? (
                <RDialog.Description className="mt-4 mb-0 text-text-secondary">
                  {description}
                </RDialog.Description>
              ) : null}
            </header>
            {/* The body scrolls so a long body never pushes the actions out of the viewport. */}
            <div className="min-h-0 overflow-y-auto overscroll-contain px-20 pt-8 pb-20 text-text-secondary">
              {children}
            </div>
            <footer className="shrink-0 flex flex-wrap justify-end gap-8 px-20 py-12 border-t border-border-subtle">
              {actions}
            </footer>
          </RDialog.Content>
        </div>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
