"use client";

import { IconButton, PropertyList, StateChip, type RecordState } from "@xos/ui";
import { Dialog as RDialog } from "radix-ui";
import { type ReactNode } from "react";
import { useFinanceT } from "./kit-use-finance-t";
import { useQueryNav } from "./kit-use-query-nav";

// Peek -----------------------------------------------------------------------------------------------

/**
 * The record peek beside the list: non-modal, Esc closes, and the full page opens the same anatomy
 * at `&full=1` (broadcast 1, item 4); a page whose records have no full page passes
 * `fullPage={false}` (saved reports). The kind label is catalog copy because finance documents are
 * not one of the 26 record kinds. The panel is a record region for the shell's record shortcuts
 * (data-shortcut-scope, @xos/ui/shortcut-targets), with Open full as the Open full page target.
 */
export function RecordPeek({
  kindLabel,
  recordKey,
  title,
  state,
  stateLabel,
  properties,
  children,
  fullPage = true,
}: {
  kindLabel: string;
  recordKey: string;
  title: string;
  state: RecordState;
  stateLabel: string;
  properties: { label: string; value: ReactNode }[];
  children?: ReactNode;
  /** False where the record has no full page, so the peek offers none. */
  fullPage?: boolean;
}) {
  const t = useFinanceT();
  const go = useQueryNav();
  return (
    <RDialog.Root
      open
      onOpenChange={(open) => (open ? null : go({ peek: null, full: null }))}
      modal={false}
    >
      <RDialog.Portal>
        <RDialog.Content
          aria-describedby={undefined}
          data-shortcut-scope="record"
          onInteractOutside={(e) => e.preventDefault()}
          className="xos-anim-peek fixed inset-y-0 end-0 z-peek flex w-(--layout-peek) max-w-full flex-col overflow-y-auto border-s border-border-subtle bg-bg-raised text-text-primary shadow-dialog max-md:w-full forced-colors:border print:hidden"
        >
          <header className="flex items-center justify-between border-b border-border-subtle py-8 ps-20 pe-12">
            <span className="flex items-center gap-6 text-text-secondary">
              <span>{kindLabel}</span>
              <span className="font-mono text-text-12">{recordKey}</span>
            </span>
            <span className="flex items-center gap-2">
              {fullPage ? (
                <IconButton
                  icon="Maximize2"
                  label={t("common.openFull")}
                  onClick={() => go({ full: "1" })}
                  data-shortcut="record.open"
                />
              ) : null}
              <RDialog.Close asChild>
                <IconButton icon="X" label={t("common.close")} shortcut="Esc" />
              </RDialog.Close>
            </span>
          </header>
          <div className="flex flex-col gap-16 p-20">
            <RDialog.Title className="m-0 text-heading-20 font-semibold">{title}</RDialog.Title>
            <div className="flex flex-wrap items-center gap-8">
              <StateChip state={state} label={stateLabel} />
            </div>
            <PropertyList items={properties} />
            {children}
          </div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
