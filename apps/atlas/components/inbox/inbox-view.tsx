"use client";

import { Button, Dialog, Kbd, Textarea } from "@xos/ui";
import type { Route } from "next";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { quickInboxAction, rejectInboxAction } from "@/app/[org]/inbox/actions";
import { ActionForm, EmptyPanel, Feedback, usePlatformT } from "@/components/platform/kit";
import { neighbourOf } from "@/lib/inbox/focus";
import type { PlatformActionState } from "@/lib/platform/state";

export interface InboxRow {
  readonly id: string;
  readonly section: "Needs You" | "For Your Information";
  readonly kind: string;
  readonly unread: boolean;
  readonly summary: string;
  readonly detail: string;
  /** Where the item opens (Enter, or the Open link); null when it has nowhere to go. */
  readonly href: string | null;
  readonly when: string;
  /** True when the item is an approval request that can be decided from here now. */
  readonly approvable: boolean;
}

type Quick = "approve" | "done" | "snooze";

/** Shortcut keys shown above the list; the keys are the same in every language. */
const KEY_HINTS: readonly (readonly [readonly string[], string])[] = [
  [["J", "K"], "move"],
  [["A"], "approve"],
  [["R"], "reject"],
  [["E"], "done"],
  [["H"], "snooze"],
  [["Enter"], "open"],
];

/**
 * The Inbox list (Section 11.10 rule 5). Keyboard: J or Down and K or Up move between items, A approves,
 * R rejects with a reason, E marks Done, H snoozes until tomorrow and Enter opens the item. Acting removes
 * the item at once and moves to the next, so a queue is cleared without waiting; a refusal puts the item
 * back and says why.
 *
 * The selection is held by item id, not by position, and the focus moves to the neighbour before the
 * acted-on item leaves the DOM (journey 57): focus never falls to the page body between two key presses,
 * so a run of A presses never stalls, however fast they come or whenever the server refresh lands.
 */
export function InboxView({ org, rows }: { org: string; rows: readonly InboxRow[] }) {
  const t = usePlatformT();
  const router = useRouter();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<PlatformActionState>({});
  const [rejecting, setRejecting] = useState<InboxRow | null>(null);
  const [handled, setHandled] = useState(0);
  const items = rows.filter((r) => !hidden.has(r.id));
  const refs = useRef(new Map<string, HTMLElement>());
  const listRef = useRef<HTMLUListElement>(null);
  /** The item that should hold the focus after the next render, when the list changed under it. */
  const pendingFocus = useRef<string | null>(null);
  /** The item to focus once the reject dialog has closed and returned its own focus. */
  const afterDialog = useRef<string | null>(null);

  const currentIndex = Math.max(
    0,
    items.findIndex((r) => r.id === selectedId),
  );
  const current = items[currentIndex];

  const focusRow = useCallback((id: string | null) => {
    if (!id) return;
    setSelectedId(id);
    const el = refs.current.get(id);
    if (el) el.focus();
    else pendingFocus.current = id;
  }, []);

  const focusItem = useCallback(
    (index: number) => {
      const row = items[index];
      if (row) focusRow(row.id);
    },
    [items, focusRow],
  );

  /** Moves the focus off a row that is about to leave, onto its neighbour (or the list when none is left). */
  const handOff = useCallback(
    (id: string) => {
      const next = neighbourOf(
        items.map((r) => r.id),
        id,
      );
      if (next) focusRow(next);
      else {
        setSelectedId(null);
        pendingFocus.current = null;
      }
    },
    [items, focusRow],
  );

  const act = useCallback(
    (row: InboxRow, action: Quick) => {
      if (action === "approve" && !row.approvable) return;
      handOff(row.id);
      setHidden((prev) => new Set(prev).add(row.id));
      setHandled((n) => n + 1);
      void quickInboxAction({ org, id: row.id, action }).then((result) => {
        setOutcome(result);
        if (!result.ok) {
          setHidden((prev) => {
            const next = new Set(prev);
            next.delete(row.id);
            return next;
          });
          setHandled((n) => n - 1);
        }
      });
    },
    [org, handOff],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const onControl =
      event.target instanceof HTMLButtonElement || event.target instanceof HTMLAnchorElement;
    if (onControl && (event.key === "Enter" || event.key === " ")) return;
    const row = current;
    switch (event.key.toLowerCase()) {
      case "j":
      case "arrowdown":
        event.preventDefault();
        focusItem(Math.min(currentIndex + 1, items.length - 1));
        return;
      case "k":
      case "arrowup":
        event.preventDefault();
        focusItem(Math.max(currentIndex - 1, 0));
        return;
      case "enter":
        if (row?.href) {
          event.preventDefault();
          router.push(row.href as Route);
        }
        return;
      case "a":
        if (row?.approvable) {
          event.preventDefault();
          act(row, "approve");
        }
        return;
      case "e":
        if (row) {
          event.preventDefault();
          act(row, "done");
        }
        return;
      case "h":
        if (row) {
          event.preventDefault();
          act(row, "snooze");
        }
        return;
      case "r":
        if (row?.approvable) {
          event.preventDefault();
          setRejecting(row);
        }
        return;
    }
  };

  // The dialog hands focus back on a timer after it unmounts; the neighbour takes it after that.
  useEffect(() => {
    const id = afterDialog.current;
    if (rejecting !== null || id === null) return;
    afterDialog.current = null;
    const timer = window.setTimeout(() => focusRow(id), 0);
    return () => window.clearTimeout(timer);
  }, [rejecting, focusRow]);

  // Before paint: focus a row that was not mounted yet when it was chosen, and keep the focus inside the
  // list when the server refresh removes the focused row, so no key press lands on the page body.
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (pending && refs.current.has(pending)) {
      pendingFocus.current = null;
      refs.current.get(pending)?.focus();
      return;
    }
    const active = document.activeElement;
    const lost = active === null || active === document.body;
    if (lost && selectedId !== null && current && current.id !== selectedId) {
      refs.current.get(current.id)?.focus();
    }
  }, [items, current, selectedId]);

  if (items.length === 0) {
    return (
      <div className="flex flex-col gap-12">
        {handled > 0 ? (
          <p role="status" className="m-0 text-text-13">
            {t("inbox.cleared", { count: handled })}
          </p>
        ) : null}
        <EmptyPanel
          icon="Inbox"
          sentence={t("inbox.empty")}
          actionLabel={t("inbox.emptyAction")}
          href={`/${org}/my-work`}
        />
      </div>
    );
  }

  const sections = (["Needs You", "For Your Information"] as const).map((section) => ({
    section,
    rows: items.filter((r) => r.section === section),
  }));

  return (
    <div className="flex flex-col gap-16">
      <p className="m-0 hidden flex-wrap items-center gap-8 text-text-12 text-text-secondary md:flex">
        <span>{t("inbox.keys.title")}</span>
        {KEY_HINTS.map(([keys, label]) => (
          <span key={label} className="inline-flex items-center gap-4">
            {keys.map((k) => (
              <Kbd key={k}>{k}</Kbd>
            ))}
            {t(`inbox.keys.${label}`)}
          </span>
        ))}
      </p>
      <div aria-live="polite" className="flex flex-col gap-4">
        {handled > 0 ? (
          <p role="status" className="m-0 text-text-13">
            {t("inbox.handled", { count: handled })}
          </p>
        ) : null}
        <Feedback state={outcome} />
      </div>
      <ul
        ref={listRef}
        aria-label={t("inbox.listLabel")}
        onKeyDown={onKeyDown}
        className="m-0 flex list-none flex-col gap-16 p-0"
      >
        {sections.map(({ section, rows: sectionRows }) =>
          sectionRows.length === 0 ? null : (
            <li key={section} className="flex flex-col gap-8">
              <h2 className="m-0 text-text-13 font-semibold text-text-secondary">
                {t(section === "Needs You" ? "inbox.needsYou" : "inbox.fyi")} · {sectionRows.length}
              </h2>
              <ul className="m-0 flex list-none flex-col gap-4 p-0">
                {sectionRows.map((row) => {
                  const isCurrent = row.id === current?.id;
                  return (
                    <li key={row.id}>
                      <article
                        ref={(el) => {
                          if (el) refs.current.set(row.id, el);
                          else refs.current.delete(row.id);
                        }}
                        tabIndex={isCurrent ? 0 : -1}
                        aria-label={`${row.summary}. ${row.detail}`}
                        aria-current={isCurrent ? "true" : undefined}
                        data-inbox-item={row.id}
                        onFocus={() => setSelectedId(row.id)}
                        className={`flex flex-wrap items-start justify-between gap-12 rounded-card border p-12 focus-visible:outline-(length:--stroke-width-focus) focus-visible:outline-focus-ring ${
                          isCurrent ? "border-border-strong bg-bg-selected" : "border-border-subtle"
                        }`}
                      >
                        <div className="flex min-w-0 flex-col gap-2">
                          <p className={`m-0 text-text-14 ${row.unread ? "font-semibold" : ""}`}>
                            {row.summary}
                          </p>
                          <p className="m-0 text-text-13 text-text-secondary">{row.detail}</p>
                          <p className="m-0 text-text-12 text-text-tertiary">{row.when}</p>
                        </div>
                        <div className="flex flex-wrap items-center gap-4">
                          {row.href ? (
                            <NextLink
                              href={row.href as Route}
                              tabIndex={isCurrent ? 0 : -1}
                              className="xos-hit inline-flex items-center px-8 text-text-13 font-medium text-accent-text no-underline hover:underline"
                            >
                              {t("inbox.open")}
                            </NextLink>
                          ) : null}
                          {row.approvable ? (
                            <>
                              <Button
                                size="sm"
                                variant="primary"
                                onClick={() => act(row, "approve")}
                              >
                                {t("inbox.approve")}
                              </Button>
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => setRejecting(row)}
                              >
                                {t("inbox.reject")}
                              </Button>
                            </>
                          ) : null}
                          <Button size="sm" variant="ghost" onClick={() => act(row, "done")}>
                            {t("inbox.done")}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => act(row, "snooze")}>
                            {t("inbox.snooze")}
                          </Button>
                        </div>
                      </article>
                    </li>
                  );
                })}
              </ul>
            </li>
          ),
        )}
      </ul>
      {rejecting ? (
        <Dialog
          title={t("inbox.rejectTitle")}
          open
          onOpenChange={(open) => (open ? null : setRejecting(null))}
          actions={null}
        >
          <p className="m-0 text-text-13">{rejecting.summary}</p>
          <ActionForm
            action={rejectInboxAction}
            hidden={{ org, id: rejecting.id }}
            label={t("inbox.rejectTitle")}
            submitLabel={t("inbox.rejectSubmit")}
            submitVariant="danger"
            onDone={() => {
              const next = neighbourOf(
                items.map((r) => r.id),
                rejecting.id,
              );
              afterDialog.current = next;
              setSelectedId(next);
              setHidden((prev) => new Set(prev).add(rejecting.id));
              setHandled((n) => n + 1);
              setRejecting(null);
              router.refresh();
            }}
          >
            <Textarea
              id="reject-reason"
              name="reason"
              label={t("inbox.rejectReason")}
              required
              maxLength={2000}
              rows={3}
              width="100%"
              autoFocus
            />
          </ActionForm>
        </Dialog>
      ) : null}
    </div>
  );
}
