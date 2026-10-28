import { useState, type CSSProperties, type KeyboardEvent, type ReactElement } from "react";
import { Dialog as RDialog } from "radix-ui";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { useReturnFocus } from "../lib/hooks.ts";
import { IconButton } from "../Button/Button.tsx";
import { RecordKindGlyph } from "../Glyphs/Glyphs.tsx";
import { StateChip } from "../Chips/Chips.tsx";
import { useOverlayOpen } from "./Overlays.shared.tsx";
import { type SidePeekProps } from "./Overlays.types.ts";
import { PropertyList } from "./PropertyList.tsx";
import { panelClass } from "./panelClass.tsx";

/**
 * Opens a record beside the list with the one record anatomy. Non-modal: the list stays usable, Esc
 * closes and the width resizes from 440 to 960 px with the handle or arrow keys. The panel is a record
 * region for the shell's record shortcuts (data-shortcut-scope, lib/shortcut-targets.ts): Open full,
 * Copy link and a clickable state carry their shortcut ids, and so can controls in `children`.
 */
export function SidePeek({
  recordKey,
  kind,
  title,
  state,
  stateLabel,
  chips,
  properties,
  children,
  onOpenFull,
  onCopyLink,
  onStateClick,
  ...control
}: SidePeekProps): ReactElement {
  const t = useT();
  const [isOpen, setOpen] = useOverlayOpen(control);
  const returnFocus = useReturnFocus(isOpen);
  const [width, setWidth] = useState(560);
  const resize = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowLeft" ? 16 : e.key === "ArrowRight" ? -16 : 0;
    if (step !== 0) {
      e.preventDefault();
      setWidth((w) => Math.min(960, Math.max(440, w + step)));
    }
  };
  return (
    <RDialog.Root open={isOpen} onOpenChange={setOpen} modal={false}>
      {control.trigger ? <RDialog.Trigger asChild>{control.trigger}</RDialog.Trigger> : null}
      <RDialog.Portal>
        <RDialog.Content
          aria-describedby={undefined}
          data-shortcut-scope="record"
          onInteractOutside={(e) => e.preventDefault()}
          onCloseAutoFocus={returnFocus}
          className={cx(
            panelClass,
            "xos-anim-peek fixed inset-y-0 end-0 z-peek flex flex-col rounded-none overflow-y-auto",
            "w-(--xos-peek-width) max-w-full max-md:w-full",
          )}
          style={
            { "--xos-peek-width": `calc(var(--layout-peek) * ${width / 560})` } as CSSProperties
          }
        >
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t("panel.resize")}
            aria-valuenow={width}
            aria-valuemin={440}
            aria-valuemax={960}
            tabIndex={0}
            onKeyDown={resize}
            className="absolute inset-y-0 start-0 w-(--ui-handle) cursor-col-resize hover:bg-accent focus-visible:bg-accent max-md:hidden"
          />
          <header className="flex items-center justify-between py-8 ps-20 pe-12 border-b border-border-subtle">
            <span className="flex items-center gap-6 text-text-secondary">
              <RecordKindGlyph kind={kind} size={14} />
              <span>{kind}</span>
              <span className="font-mono text-text-12">{recordKey}</span>
            </span>
            <span className="flex items-center gap-2">
              <IconButton
                icon="Maximize2"
                label={t("peek.openFull")}
                onClick={onOpenFull}
                data-shortcut="record.open"
              />
              <IconButton
                icon="Link2"
                label={t("action.copyLink")}
                onClick={onCopyLink}
                data-shortcut="record.copy-link"
              />
              <RDialog.Close asChild>
                <IconButton icon="X" label={t("action.close")} shortcut={t("key.esc")} />
              </RDialog.Close>
            </span>
          </header>
          <div className="flex flex-col gap-16 p-20">
            <RDialog.Title className="m-0 text-heading-20 font-semibold">{title}</RDialog.Title>
            <div className="flex flex-wrap items-center gap-8">
              {onStateClick ? (
                <span data-shortcut="record.state" className="contents">
                  <StateChip state={state} label={stateLabel} onClick={onStateClick} />
                </span>
              ) : (
                <StateChip state={state} label={stateLabel} />
              )}
              {chips}
            </div>
            {properties ? <PropertyList items={properties} /> : null}
            {children}
          </div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
