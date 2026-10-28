"use client";

import type { DialogProps, DrawerProps } from "@xos/ui";
import {
  cloneElement,
  isValidElement,
  useState,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { Dialog } from "./dialog";
import { Drawer } from "./drawer";

/*
 * lazy-ui holds the @xos/ui components a page renders only in some states: the collection views
 * a person switches to (board, calendar, gallery, list, table, timeline, tree, chart), the bulk bar
 * a selection shows, and overlays that open on an action or a query parameter (Drawer, Dialog; this
 * file keeps an overlay's trigger with the page). Through next/dynamic their code loads when they
 * first render, not with every route that might show them (ADR 0027, A24-009). A component a route
 * renders in its default state is imported from @xos/ui directly, so the route budget counts it.
 *
 * Each wrapper is its own module (`./board`, `./dialog`, ...), so a page carries the loaders of
 * only the components it imports, and each wrapper loads a `./targets` module that re-exports one
 * component from @xos/ui, so a chunk holds only that component.
 */

interface Control {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactElement;
}

/**
 * Open state for an overlay whose trigger renders with the page while its code loads on first open
 * (ADR 0027, A24-009). Like @xos/ui's overlays: controlled with `open`, otherwise closed until the
 * trigger opens it (open while mounted when there is no trigger). The trigger keeps the dialog
 * trigger's ARIA (aria-haspopup, aria-expanded) and data-state, so it reads and styles the same.
 */
function useDeferredOverlay({ open, defaultOpen, onOpenChange, trigger }: Control) {
  const [inner, setInner] = useState(defaultOpen ?? trigger === undefined);
  const isOpen = open ?? inner;
  const [mounted, setMounted] = useState(isOpen);
  if (isOpen && !mounted) setMounted(true);
  const change = (next: boolean) => {
    if (open === undefined) setInner(next);
    onOpenChange?.(next);
  };
  let button: ReactNode = null;
  if (isValidElement<{ onClick?: (event: MouseEvent<HTMLElement>) => void }>(trigger)) {
    const own = trigger.props.onClick;
    button = cloneElement(trigger as ReactElement<Record<string, unknown>>, {
      "aria-haspopup": "dialog",
      "aria-expanded": isOpen,
      "data-state": isOpen ? "open" : "closed",
      onClick: (event: MouseEvent<HTMLElement>) => {
        own?.(event);
        if (!event.defaultPrevented) change(!isOpen);
      },
    });
  }
  return { isOpen, mounted, change, button };
}

/** @xos/ui Dialog whose trigger renders at once and whose dialog loads when first opened. */
export function DeferredDialog({ open, defaultOpen, onOpenChange, trigger, ...rest }: DialogProps) {
  const o = useDeferredOverlay({
    ...(open === undefined ? {} : { open }),
    ...(defaultOpen === undefined ? {} : { defaultOpen }),
    ...(onOpenChange ? { onOpenChange } : {}),
    ...(trigger ? { trigger } : {}),
  });
  return (
    <>
      {o.button}
      {o.mounted ? <Dialog {...rest} open={o.isOpen} onOpenChange={o.change} /> : null}
    </>
  );
}

/** @xos/ui Drawer whose trigger renders at once and whose drawer loads when first opened. */
export function DeferredDrawer({ open, defaultOpen, onOpenChange, trigger, ...rest }: DrawerProps) {
  const o = useDeferredOverlay({
    ...(open === undefined ? {} : { open }),
    ...(defaultOpen === undefined ? {} : { defaultOpen }),
    ...(onOpenChange ? { onOpenChange } : {}),
    ...(trigger ? { trigger } : {}),
  });
  return (
    <>
      {o.button}
      {o.mounted ? <Drawer {...rest} open={o.isOpen} onOpenChange={o.change} /> : null}
    </>
  );
}
