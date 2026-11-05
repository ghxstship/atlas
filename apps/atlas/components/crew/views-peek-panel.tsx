"use client";

import { IconButton, StateChip, type RecordState } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, type ReactNode } from "react";
import { Dialog as RDialog } from "radix-ui";
import { useQueryHref } from "./views.shared";

/**
 * The side peek (Section 11.2, rule 4): non-modal, so the list stays usable; Esc closes; full screen
 * below md. Closing removes `peek` from the URL. The record anatomy inside is rendered on the server.
 * The panel is a record region for the shell's record shortcuts (@xos/ui/shortcut-targets), with
 * Open full and Copy link as their targets.
 */
export function PeekPanel(props: {
  kindLabel: string;
  recordKey: string;
  title: string;
  state: RecordState;
  stateLabel: string;
  children: ReactNode;
}) {
  const t = useTranslations("crew.peek");
  const router = useRouter();
  const href = useQueryHref();
  const close = () => router.push(href({ peek: null, full: null }));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return (
    <RDialog.Root open modal={false} onOpenChange={(open) => (open ? undefined : close())}>
      <RDialog.Portal>
        <RDialog.Content
          aria-describedby={undefined}
          data-shortcut-scope="record"
          onInteractOutside={(e) => e.preventDefault()}
          className="xos-anim-peek fixed inset-y-0 end-0 z-peek flex w-(--layout-peek) max-w-full flex-col overflow-y-auto border-s border-border-subtle bg-bg-raised text-text-primary shadow-dialog max-md:w-full"
        >
          <header className="flex items-center justify-between border-b border-border-subtle py-8 ps-20 pe-12">
            <span className="flex items-center gap-6 text-text-12 text-text-secondary">
              <span>{props.kindLabel}</span>
              <span className="font-mono">{props.recordKey}</span>
            </span>
            <span className="flex items-center gap-2">
              <IconButton
                icon="Maximize2"
                label={t("openFull")}
                onClick={() => router.push(href({ full: "1" }))}
                data-shortcut="record.open"
              />
              <IconButton
                icon="Link2"
                label={t("copyLink")}
                data-shortcut="record.copy-link"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(window.location.href)
                    .catch((error: unknown) => {
                      console.error("Copying the link failed", error);
                    });
                }}
              />
              <RDialog.Close asChild>
                <IconButton icon="X" label={t("close")} shortcut="Esc" />
              </RDialog.Close>
            </span>
          </header>
          <div className="flex flex-col gap-16 p-20">
            <RDialog.Title className="m-0 text-heading-20 font-semibold">
              {props.title}
            </RDialog.Title>
            <div>
              <StateChip state={props.state} label={props.stateLabel} />
            </div>
            {props.children}
          </div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
