import {
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  Dialog as RDialog,
  HoverCard as RHoverCard,
  Popover as RPopover,
  Tooltip as RTooltip,
} from "radix-ui";
import type {
  DialogProps as ReferenceDialogProps,
  DrawerProps as ReferenceDrawerProps,
  HoverCardProps as ReferenceHoverCardProps,
  PopoverProps as ReferencePopoverProps,
  ShortcutSheetProps as ReferenceShortcutSheetProps,
  SidePeekProps as ReferenceSidePeekProps,
  TooltipProps as ReferenceTooltipProps,
} from "../types/reference";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { useControllable } from "../lib/hooks.ts";
import { Icon } from "../Icon/Icon.tsx";
import { IconButton } from "../Button/Button.tsx";
import { Keys } from "../Kbd/Kbd.tsx";
import { linkClass } from "../Link/Link.tsx";
import { RecordKindGlyph } from "../Glyphs/Glyphs.tsx";
import { PropertyChip, StateChip } from "../Chips/Chips.tsx";

/** Open state shared by every overlay: controlled with `open`, or mounted open unless a `trigger` opens it. */
export interface OverlayControl {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The element that opens the overlay. Without one, the overlay renders open while mounted. */
  trigger?: ReactElement;
}

export type DialogProps = ReferenceDialogProps &
  OverlayControl & {
    /** One sentence under the title, announced with it. */
    description?: ReactNode;
  };
export type DrawerProps = ReferenceDrawerProps & OverlayControl;
export type SidePeekProps = ReferenceSidePeekProps &
  OverlayControl & {
    onOpenFull?: () => void;
    onCopyLink?: () => void;
    /** Opens the state menu from the state chip. */
    onStateClick?: () => void;
  };
export type ShortcutSheetProps = ReferenceShortcutSheetProps & OverlayControl;
export type PopoverProps = ReferencePopoverProps &
  Omit<OverlayControl, "defaultOpen"> & { defaultOpen?: boolean };
export type HoverCardProps = ReferenceHoverCardProps & {
  /** The record key or link the card previews; without it the card renders on its own. */
  children?: ReactElement;
  openDelay?: number;
};
export type TooltipProps = ReferenceTooltipProps & {
  /** The control the tooltip describes; without it the bubble renders on its own. */
  children?: ReactElement;
  side?: "top" | "right" | "bottom" | "left";
  /** Hover delay in milliseconds; 500 by default. */
  delay?: number;
};

const scrimClass = cx(
  "xos-anim-fade fixed inset-0 z-dialog bg-scrim opacity-scrim-dark",
  "in-data-[theme=light]:opacity-scrim-light in-data-[theme=sunlight]:opacity-scrim-light",
);

export const panelClass = cx(
  "bg-bg-raised text-text-primary shadow-dialog rounded-dialog box-border max-w-full",
  "forced-colors:border-[CanvasText] forced-colors:border print:shadow-none",
);

export const popoverPanelClass = cx(
  "xos-anim-pop bg-bg-raised text-text-primary shadow-menu rounded-card box-border",
  "max-w-[calc(100vw-var(--space-32))] forced-colors:border",
);

function useOverlayOpen({ open, defaultOpen, onOpenChange, trigger }: OverlayControl) {
  return useControllable(open, defaultOpen ?? trigger === undefined, onOpenChange);
}

/** For irreversible actions only; everything else uses Undo. Focus is trapped and Esc closes. */
export function Dialog({
  title,
  children,
  actions,
  description,
  ...control
}: DialogProps): ReactElement {
  const [isOpen, setOpen] = useOverlayOpen(control);
  return (
    <RDialog.Root open={isOpen} onOpenChange={setOpen}>
      {control.trigger ? <RDialog.Trigger asChild>{control.trigger}</RDialog.Trigger> : null}
      <RDialog.Portal>
        <RDialog.Overlay className={scrimClass} />
        <div className="pointer-events-none fixed inset-0 z-dialog grid place-items-center p-16">
          <RDialog.Content
            className={cx(panelClass, "xos-anim-dialog pointer-events-auto w-(--ui-dialog)")}
            {...(description ? {} : { "aria-describedby": undefined })}
          >
            <header className="px-20 pt-20">
              <RDialog.Title className="m-0 text-heading-16 font-semibold">{title}</RDialog.Title>
              {description ? (
                <RDialog.Description className="mt-4 mb-0 text-text-secondary">
                  {description}
                </RDialog.Description>
              ) : null}
            </header>
            <div className="px-20 pt-8 pb-20 text-text-secondary">{children}</div>
            <footer className="flex flex-wrap justify-end gap-8 px-20 py-12 border-t border-border-subtle">
              {actions}
            </footer>
          </RDialog.Content>
        </div>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

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

/** Label and value pairs in the record property column. */
export function PropertyList({
  items,
}: {
  items: { label: string; value: ReactNode }[];
}): ReactElement {
  return (
    <dl className="grid grid-cols-[var(--ui-props-label)_1fr] max-sm:grid-cols-1 items-center gap-x-16 gap-y-8 m-0">
      {items.map((p) => (
        <div key={p.label} className="contents">
          <dt className="text-text-12 text-text-secondary">{p.label}</dt>
          <dd className="m-0">{p.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Opens a record beside the list with the one record anatomy. Non-modal: the list stays usable, Esc
 * closes and the width resizes from 440 to 960 px with the handle or arrow keys.
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
          onInteractOutside={(e) => e.preventDefault()}
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
              <IconButton icon="Maximize2" label={t("peek.openFull")} onClick={onOpenFull} />
              <IconButton icon="Link2" label={t("action.copyLink")} onClick={onCopyLink} />
              <RDialog.Close asChild>
                <IconButton icon="X" label={t("action.close")} shortcut={t("key.esc")} />
              </RDialog.Close>
            </span>
          </header>
          <div className="flex flex-col gap-16 p-20">
            <RDialog.Title className="m-0 text-heading-20 font-semibold">{title}</RDialog.Title>
            <div className="flex flex-wrap items-center gap-8">
              <StateChip
                state={state}
                label={stateLabel}
                {...(onStateClick ? { onClick: onStateClick } : {})}
              />
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

/** Every shortcut by group; `?` opens it (bind with useHotkey). */
export function ShortcutSheet({ title, groups, ...control }: ShortcutSheetProps): ReactElement {
  const t = useT();
  const [isOpen, setOpen] = useOverlayOpen(control);
  return (
    <RDialog.Root open={isOpen} onOpenChange={setOpen}>
      {control.trigger ? <RDialog.Trigger asChild>{control.trigger}</RDialog.Trigger> : null}
      <RDialog.Portal>
        <RDialog.Overlay className={scrimClass} />
        <div className="pointer-events-none fixed inset-0 z-dialog grid place-items-center p-16">
          <RDialog.Content
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

function HoverCardBody({
  recordKey,
  kind,
  title,
  state,
  stateLabel,
  owner,
  next,
}: ReferenceHoverCardProps) {
  return (
    <>
      <div className="flex items-center gap-6 text-text-secondary">
        <RecordKindGlyph kind={kind} size={14} />
        <span className="font-mono text-text-12">{recordKey}</span>
      </div>
      <strong className="font-semibold">{title}</strong>
      <div className="flex flex-wrap items-center gap-8">
        <StateChip state={state} label={stateLabel} />
        <PropertyChip icon="User" value={owner} />
        <PropertyChip icon="Calendar" value={next} />
      </div>
    </>
  );
}

const hoverCardClass = cx(
  popoverPanelClass,
  "flex flex-col gap-8 p-12 w-(--ui-hovercard) z-popover",
);

/** Previews a record after 400 ms on its key: title, state, owner and next date. */
export function HoverCard({ children, openDelay = 400, ...record }: HoverCardProps): ReactElement {
  if (children === undefined) {
    return (
      <div className={hoverCardClass}>
        <HoverCardBody {...record} />
      </div>
    );
  }
  return (
    <RHoverCard.Root openDelay={openDelay} closeDelay={100}>
      <RHoverCard.Trigger asChild>{children}</RHoverCard.Trigger>
      <RHoverCard.Portal>
        <RHoverCard.Content sideOffset={4} collisionPadding={16} className={hoverCardClass}>
          <HoverCardBody {...record} />
        </RHoverCard.Content>
      </RHoverCard.Portal>
    </RHoverCard.Root>
  );
}

const tooltipClass = cx(
  "xos-anim-pop inline-flex items-center gap-6 px-8 py-4 rounded-control bg-bg-raised text-text-primary",
  "text-text-12 shadow-menu z-tooltip forced-colors:border",
);

/**
 * A control's label and shortcut after 500 ms of hover, on focus, or on a 500 ms long press. Never
 * holds interactive content.
 */
export function Tooltip({
  label,
  shortcut,
  children,
  side = "top",
  delay = 500,
}: TooltipProps): ReactElement {
  const t = useT();
  const [open, setOpen] = useState(false);
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const content = (
    <>
      <span>{label}</span>
      {shortcut ? <Keys keys={shortcut} /> : null}
    </>
  );
  if (children === undefined) {
    return (
      <span role="tooltip" className={tooltipClass}>
        {content}
      </span>
    );
  }
  const endPress = () => {
    if (press.current !== null) clearTimeout(press.current);
    press.current = null;
  };
  return (
    <RTooltip.Provider delayDuration={delay}>
      <RTooltip.Root open={open} onOpenChange={setOpen}>
        <RTooltip.Trigger
          asChild
          onPointerDown={(e) => {
            if (e.pointerType !== "touch") return;
            endPress();
            press.current = setTimeout(() => setOpen(true), delay);
          }}
          onPointerUp={endPress}
          onPointerCancel={endPress}
        >
          {children}
        </RTooltip.Trigger>
        <RTooltip.Portal>
          <RTooltip.Content
            side={side}
            sideOffset={6}
            collisionPadding={16}
            className={tooltipClass}
            aria-label={shortcut ? t("tooltip.withShortcut", { label, shortcut }) : label}
          >
            {content}
          </RTooltip.Content>
        </RTooltip.Portal>
      </RTooltip.Root>
    </RTooltip.Provider>
  );
}
