"use client";

import { chordOf } from "@xos/schemas/shortcuts/keys";
import { Button, Dialog, Kbd, Textarea } from "@xos/ui";
import type { Route } from "next";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { singleKeyShortcutsEnabled } from "@xos/ui/preferences";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { quickInboxAction, rejectInboxAction } from "@/app/[org]/inbox/actions";
import { ActionForm, EmptyPanel, Feedback, usePlatformT } from "@/components/platform/kit";
// The bulk bar shows only with a selection, so it loads then (A24-009).
import { BulkActionBar } from "@/components/lazy-ui/bulk-action-bar";
import { useShellKeys } from "@/components/shell/shell-keys-context";
import { neighbourOf, neighbourOutside, selectItems } from "@/lib/inbox/focus";
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

/**
 * Shortcuts on the focused item, by registry id (packages/schemas/shortcuts.yaml, scope inbox), with the
 * hint label each shows above the list. J and K move as in every list (list.next and list.previous).
 */
const ACTIONS = [
  ["inbox.approve", "approve"],
  ["inbox.reject", "reject"],
  ["inbox.done", "done"],
  ["inbox.snooze", "snooze"],
] as const;
const MODIFIER = /(?:^|\+)(?:Mod|Ctrl|Alt)\+/;

/**
 * Sends one quick act. Approve and Done go straight to the public API's notification action (the
 * same app.act_on_notification a push notification calls), one request per key press, so a run of A
 * presses is decided in parallel and each request is on its way the moment the key is pressed:
 * server actions run one after another, so twenty queued approvals could still be waiting, and be
 * lost with the tab, long after the list looked clear. Snooze stays a server action.
 */
async function sendAct(org: string, id: string, action: Quick): Promise<PlatformActionState> {
  if (action === "snooze") return quickInboxAction({ org, id, action });
  try {
    const response = await fetch(`/api/v1/notifications/${encodeURIComponent(id)}/act`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ action }),
    });
    if (response.ok) return { ok: true, id, at: Date.now() };
    const body = (await response.json().catch(() => null)) as { rule?: unknown } | null;
    if (typeof body?.rule === "string") return { rule: body.rule, at: Date.now() };
    return { error: response.status === 404 ? "notFound" : "unexpected", at: Date.now() };
  } catch {
    return { error: "unexpected", at: Date.now() };
  }
}

/**
 * The Inbox list (Section 11.10 rule 5). Keyboard: J or Down and K or Up move between items, A approves,
 * R rejects with a reason, E marks Done, H snoozes until tomorrow and Enter opens the item, as the
 * person's shortcuts say (Personal settings, Keyboard Shortcuts). Single character-key shortcuts obey
 * me.shortcuts_enabled; function keys F13 to F20 do not, because WCAG 2.1.4 covers character keys only.
 * The arrow keys and Enter always work. Acting removes the item at once and moves to the next, so a queue
 * is cleared without waiting; a refusal puts the item back and says why.
 *
 * The selection is held by item id, not by position, and the focus moves to the neighbour before the
 * acted-on item leaves the DOM (journey 57): focus never falls to the page body between two key presses,
 * so a run of A presses never stalls, however fast they come or whenever the server refresh lands.
 *
 * Items select as list rows do (Section 11.2): X toggles the focused item and Shift+X selects the range
 * from the last toggled one, as do an item's checkbox, Cmd or Ctrl+click and Shift+click, and Esc clears.
 * With a selection, E and H, and the bulk bar's Done and Snooze, act on every selected item at once.
 */
export function InboxView({ org, rows }: { org: string; rows: readonly InboxRow[] }) {
  const t = usePlatformT();
  const keys = useShellKeys();
  const router = useRouter();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<PlatformActionState>({});
  const [rejecting, setRejecting] = useState<InboxRow | null>(null);
  const [handled, setHandled] = useState(0);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const items = rows.filter((r) => !hidden.has(r.id));
  // Only items still listed stay selected, so a refresh or an act never leaves a hidden one selected.
  const selected = useMemo(
    () => new Set(rows.filter((r) => !hidden.has(r.id) && picked.has(r.id)).map((r) => r.id)),
    [rows, hidden, picked],
  );
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

  /** Acts sent and not yet answered; the page refreshes from the server once none is left. */
  const inFlight = useRef(0);

  /** Hides an item and sends its act; a refusal puts it back. */
  const send = useCallback(
    (row: InboxRow, action: Quick) => {
      setHidden((prev) => new Set(prev).add(row.id));
      setHandled((n) => n + 1);
      inFlight.current += 1;
      void sendAct(org, row.id, action).then((result) => {
        setOutcome(result);
        if (!result.ok) {
          setHidden((prev) => {
            const next = new Set(prev);
            next.delete(row.id);
            return next;
          });
          setHandled((n) => n - 1);
        }
        inFlight.current -= 1;
        if (inFlight.current === 0) router.refresh();
      });
    },
    [org, router],
  );

  const act = useCallback(
    (row: InboxRow, action: Quick) => {
      if (action === "approve" && !row.approvable) return;
      handOff(row.id);
      send(row, action);
    },
    [handOff, send],
  );

  /** Done or Snooze on every selected item; the focus moves past all of them first. */
  const actOnSelection = useCallback(
    (action: "done" | "snooze") => {
      const targets = items.filter((r) => selected.has(r.id));
      const next = neighbourOutside(
        items.map((r) => r.id),
        current?.id ?? targets[0]?.id ?? "",
        selected,
      );
      if (next) focusRow(next);
      else {
        setSelectedId(null);
        pendingFocus.current = null;
      }
      setPicked(new Set());
      for (const row of targets) send(row, action);
    },
    [items, selected, current, focusRow, send],
  );

  const toggle = (id: string, range: boolean) => {
    const next = selectItems(
      items.map((r) => r.id),
      selected,
      anchor.current,
      id,
      range,
    );
    anchor.current = next.anchor;
    setPicked(next.selected);
  };
  /** Cmd or Ctrl+click toggles an item and Shift+click selects a range, outside its controls. */
  const onItemClick = (event: MouseEvent<HTMLElement>, id: string) => {
    const onControl = (event.target as HTMLElement).closest("a, button, input");
    if (onControl || !(event.metaKey || event.ctrlKey || event.shiftKey)) return;
    event.preventDefault();
    toggle(id, event.shiftKey && !(event.metaKey || event.ctrlKey));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const onControl =
      event.target instanceof HTMLButtonElement || event.target instanceof HTMLAnchorElement;
    if (onControl && (event.key === "Enter" || event.key === " ")) return;
    const row = current;
    const chord = chordOf(event, keys.platform);
    // Esc clears the selection first; a second Esc reaches the page.
    if (chord === "Escape" && selected.size > 0) {
      event.preventDefault();
      event.stopPropagation();
      setPicked(new Set());
      return;
    }
    // list.open (Enter) is fixed keyboard operation, so it opens the focused item whatever the setting.
    if (chord !== null && chord === (keys.scoped["list.open"] ?? "Enter")) {
      if (row?.href) {
        event.preventDefault();
        router.push(row.href as Route);
      }
      return;
    }
    // Single keys follow me.shortcuts_enabled (singleKeyShortcutsEnabled); the arrow keys always move.
    const single = !MODIFIER.test(chord ?? "") && !(chord ?? "").startsWith("Arrow");
    if (chord === null || (single && !singleKeyShortcutsEnabled())) return;
    const action = ACTIONS.find(([id]) => keys.scoped[id] === chord)?.[0];
    if (chord === "ArrowDown" || chord === keys.scoped["list.next"]) {
      event.preventDefault();
      focusItem(Math.min(currentIndex + 1, items.length - 1));
      return;
    }
    if (chord === "ArrowUp" || chord === keys.scoped["list.previous"]) {
      event.preventDefault();
      focusItem(Math.max(currentIndex - 1, 0));
      return;
    }
    // X and Shift+X select as in every list (list.select and list.select-range).
    if (
      row &&
      (chord === keys.scoped["list.select"] || chord === keys.scoped["list.select-range"])
    ) {
      event.preventDefault();
      toggle(row.id, chord === keys.scoped["list.select-range"]);
      return;
    }
    if (selected.size > 0 && (action === "inbox.done" || action === "inbox.snooze")) {
      event.preventDefault();
      actOnSelection(action === "inbox.done" ? "done" : "snooze");
      return;
    }
    switch (action) {
      case "inbox.approve":
        if (row?.approvable) {
          event.preventDefault();
          act(row, "approve");
        }
        return;
      case "inbox.done":
        if (row) {
          event.preventDefault();
          act(row, "done");
        }
        return;
      case "inbox.snooze":
        if (row) {
          event.preventDefault();
          act(row, "snooze");
        }
        return;
      case "inbox.reject":
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
        {[
          [[keys.display["list.next"], keys.display["list.previous"]], "move"] as const,
          [[keys.display["list.select"]], "select"] as const,
          ...ACTIONS.map(([id, label]) => [[keys.display[id]], label] as const),
          [[keys.display["list.open"] ?? "Enter"], "open"] as const,
        ].map(([shown, label]) =>
          shown.every((k) => k === undefined) ? null : (
            <span key={label} className="inline-flex items-center gap-4">
              {shown.map((k) => (k === undefined ? null : <Kbd key={k}>{k}</Kbd>))}
              {t(`inbox.keys.${label}`)}
            </span>
          ),
        )}
      </p>
      <div aria-live="polite" className="flex flex-col gap-4">
        {handled > 0 ? (
          <p role="status" className="m-0 text-text-13">
            {t("inbox.handled", { count: handled })}
          </p>
        ) : null}
        <Feedback state={outcome} />
      </div>
      {selected.size > 0 ? (
        <div className="pointer-events-none sticky top-16 z-sticky flex justify-center print:hidden">
          <div className="pointer-events-auto">
            <BulkActionBar
              count={selected.size}
              actions={[
                {
                  label: t("inbox.done"),
                  icon: "Check",
                  ...(keys.display["inbox.done"] ? { shortcut: keys.display["inbox.done"] } : {}),
                  onSelect: () => actOnSelection("done"),
                },
                {
                  label: t("inbox.snooze"),
                  icon: "Clock",
                  ...(keys.display["inbox.snooze"]
                    ? { shortcut: keys.display["inbox.snooze"] }
                    : {}),
                  onSelect: () => actOnSelection("snooze"),
                },
              ]}
              onClear={() => setPicked(new Set())}
            />
          </div>
        </div>
      ) : null}
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
                  const isPicked = selected.has(row.id);
                  return (
                    <li key={row.id}>
                      <article
                        ref={(el) => {
                          if (el) refs.current.set(row.id, el);
                          else refs.current.delete(row.id);
                        }}
                        tabIndex={isCurrent ? 0 : -1}
                        aria-label={
                          isPicked
                            ? `${row.summary}. ${row.detail}. ${t("inbox.selected")}`
                            : `${row.summary}. ${row.detail}`
                        }
                        aria-current={isCurrent ? "true" : undefined}
                        data-inbox-item={row.id}
                        data-selected={isPicked ? "" : undefined}
                        onFocus={() => setSelectedId(row.id)}
                        onClick={(event) => onItemClick(event, row.id)}
                        onMouseDown={(event) => {
                          // Shift+click selects a range, not the text between.
                          if (event.shiftKey) event.preventDefault();
                        }}
                        className={`flex items-start gap-12 rounded-card border p-12 focus-visible:outline-(length:--stroke-width-focus) focus-visible:outline-focus-ring ${
                          isCurrent ? "border-border-strong bg-bg-selected" : "border-border-subtle"
                        } ${isPicked ? "ring-(length:--stroke-width-focus) ring-inset ring-accent" : ""}`}
                      >
                        <input
                          type="checkbox"
                          tabIndex={-1}
                          className="xos-check-input mt-2"
                          aria-label={t("inbox.select", { item: row.summary })}
                          checked={isPicked}
                          onClick={(event) => toggle(row.id, event.shiftKey)}
                          onChange={() => undefined}
                        />
                        {/* The checkbox keeps its place beside the text, and the actions wrap below
                            the text when both do not fit on one line, as on a phone. */}
                        <div className="flex min-w-0 flex-1 flex-wrap items-start justify-between gap-12">
                          <div className="flex min-w-0 grow flex-col gap-2">
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
