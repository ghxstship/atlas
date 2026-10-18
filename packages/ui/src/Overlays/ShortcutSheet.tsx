import { type ReactElement } from "react";
import { Dialog as RDialog } from "radix-ui";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { useReturnFocus } from "../lib/hooks.ts";
import { IconButton } from "../Button/Button.tsx";
import { Keys } from "../Kbd/Kbd.tsx";
import { scrimClass, useOverlayOpen } from "./Overlays.shared.tsx";
import { type ShortcutSheetProps } from "./Overlays.types.ts";
import { panelClass } from "./panelClass.tsx";

/** Every shortcut by group; `?` opens it (bind with useHotkey). */
export function ShortcutSheet({ title, groups, ...control }: ShortcutSheetProps): ReactElement {
  const t = useT();
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
            aria-describedby={undefined}
            className={cx(
              panelClass,
              "xos-anim-dialog pointer-events-auto w-(--ui-sheet) max-h-full overflow-y-auto",
            )}
          >
            <header className="flex items-center justify-between px-20 pt-20">
              <RDialog.Title className="m-0 text-heading-16 font-semibold">
                {title ?? t("shortcuts.title")}
              </RDialog.Title>
              <RDialog.Close asChild>
                <IconButton icon="X" label={t("action.close")} shortcut={t("key.esc")} />
              </RDialog.Close>
            </header>
            <div className="grid grid-cols-2 max-md:grid-cols-1 gap-x-32 gap-y-16 px-20 pt-8 pb-20">
              {groups.map((g) => (
                <section key={g.label}>
                  <h3 className="m-0 mb-6 text-text-11 font-medium text-text-secondary">
                    {g.label}
                  </h3>
                  {g.items.map((item) => (
                    <div
                      key={item.label}
                      className="flex items-center justify-between min-h-control-md"
                    >
                      <span>{item.label}</span>
                      <Keys keys={item.keys} />
                    </div>
                  ))}
                </section>
              ))}
            </div>
          </RDialog.Content>
        </div>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
