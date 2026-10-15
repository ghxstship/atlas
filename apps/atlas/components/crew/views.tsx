"use client";

import {
  Board,
  Calendar,
  DataTable,
  IconButton,
  Select,
  StateChip,
  type DataTableColumn,
  type RecordState,
} from "@xos/ui";
import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, type ReactNode } from "react";
import { Dialog as RDialog } from "radix-ui";

/**
 * Client views for the People and Crew collections. Every view keeps the page's query string, so
 * filters, sort and grouping survive a view switch (Section 11.15), and opening a row sets
 * `?peek=<id>` so the side peek is linkable and the Back button closes it.
 */

function useQueryHref() {
  const pathname = usePathname();
  const search = useSearchParams();
  return (changes: Readonly<Record<string, string | null>>) => {
    const q = new URLSearchParams(search.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) q.delete(k);
      else q.set(k, v);
    }
    const s = q.toString();
    return (s ? `${pathname}?${s}` : pathname) as Route;
  };
}

/** A table whose rows open the side peek (Enter on a cell or a double click). */
export function PeekTable(props: {
  caption: string;
  columns: DataTableColumn[];
  rows: Array<Record<string, unknown> & { id: string }>;
  totals?: Record<string, unknown>;
  totalsLabel?: string;
  /** False for tables inside a record, whose rows open nothing. */
  activatable?: boolean;
}) {
  const router = useRouter();
  const href = useQueryHref();
  return (
    <DataTable
      caption={props.caption}
      columns={props.columns}
      rows={props.rows}
      {...(props.totals ? { totals: props.totals } : {})}
      {...(props.totalsLabel ? { totalsLabel: props.totalsLabel } : {})}
      {...(props.activatable === false
        ? {}
        : {
            onRowActivate: (row: Record<string, unknown>) =>
              router.push(href({ peek: String(row["id"]), full: null })),
          })}
    />
  );
}

/** A board by state whose cards open the side peek. Cards move only through transitions. */
export function PeekBoard(props: {
  columns: Array<{
    state: RecordState;
    label: string;
    cards: Array<{ key: string; title: string; meta?: string; owner?: string; due?: string }>;
  }>;
}) {
  const router = useRouter();
  const href = useQueryHref();
  return (
    <Board
      readOnly
      columns={props.columns}
      onOpen={(key) => router.push(href({ peek: key, full: null }))}
    />
  );
}

/** A month calendar whose events open the side peek. */
export function PeekCalendar(props: {
  month: string;
  today: string;
  events: Array<{ id: string; date: string; label: string; state: RecordState }>;
}) {
  const router = useRouter();
  const href = useQueryHref();
  return (
    <Calendar
      month={props.month}
      today={props.today}
      events={props.events}
      onEventSelect={(e) => {
        const found = props.events.find((x) => x.date === e.date && x.label === e.label);
        if (found) router.push(href({ peek: found.id, full: null }));
      }}
    />
  );
}

/** A filter that rewrites one query key; the page re-renders on the server with the new filter. */
export function FilterSelect(props: {
  name: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
}) {
  const router = useRouter();
  const href = useQueryHref();
  return (
    <Select
      label={props.label}
      value={props.value}
      options={props.options}
      onChange={(e) =>
        router.replace(
          href({ [props.name]: e.target.value === "" ? null : e.target.value, peek: null }),
        )
      }
    />
  );
}

/**
 * The side peek (Section 11.2, rule 4): non-modal, so the list stays usable; Esc closes; full screen
 * below md. Closing removes `peek` from the URL. The record anatomy inside is rendered on the server.
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
              />
              <IconButton
                icon="Link2"
                label={t("copyLink")}
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
