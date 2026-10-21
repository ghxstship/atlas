"use client";

import { chordOf } from "@xos/schemas/shortcuts/keys";
import { Button, Dialog, Kbd, Textarea } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { singleKeyShortcutsEnabled } from "@xos/ui/preferences";
import { quickInboxAction, rejectInboxAction } from "@/app/[org]/inbox/actions";
import { ActionForm, EmptyPanel, Feedback, usePlatformT } from "@/components/platform/kit";
import { useShellKeys } from "@/components/shell/shell-keys-context";
import type { PlatformActionState } from "@/lib/platform/state";

export interface InboxRow {
  readonly id: string;
  readonly section: "Needs You" | "For Your Information";
  readonly kind: string;
  readonly unread: boolean;
  readonly summary: string;
  readonly detail: string;
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
 * The Inbox list (Section 11.10 rule 5). Keyboard: J or Down and K or Up move between items, A approves,
 * R rejects with a reason, E marks Done and H snoozes until tomorrow, as the person's shortcuts say
 * (Personal settings, Keyboard Shortcuts). Single keys obey me.shortcuts_enabled; the arrow keys always
 * move. Acting removes the item at once and moves to the next, so a queue is cleared without waiting; a
 * refusal puts the item back and says why.
 */
export function InboxView({ org, rows }: { org: string; rows: readonly InboxRow[] }) {
  const t = usePlatformT();
  const keys = useShellKeys();
  const router = useRouter();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState(0);
  const [outcome, setOutcome] = useState<PlatformActionState>({});
  const [rejecting, setRejecting] = useState<InboxRow | null>(null);
  const [handled, setHandled] = useState(0);
  const items = rows.filter((r) => !hidden.has(r.id));
  const refs = useRef(new Map<string, HTMLElement>());
  const listRef = useRef<HTMLUListElement>(null);
  /** Set when an acted-on item leaves, so focus moves to the item that took its place. */
  const refocus = useRef(false);

  const current = Math.min(selected, Math.max(items.length - 1, 0));

  const focusItem = useCallback(
    (index: number) => {
      const row = items[index];
      if (!row) return;
      setSelected(index);
      refs.current.get(row.id)?.focus();
    },
    [items],
  );

  const act = useCallback(
    (row: InboxRow, action: Quick) => {
      if (action === "approve" && !row.approvable) return;
      refocus.current = true;
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
    [org],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.target instanceof HTMLButtonElement && (event.key === "Enter" || event.key === " "))
      return;
    const chord = chordOf(event, keys.platform);
    // Single keys follow me.shortcuts_enabled (singleKeyShortcutsEnabled); the arrow keys always move.
    const single = !MODIFIER.test(chord ?? "") && !(chord ?? "").startsWith("Arrow");
    if (chord === null || (single && !singleKeyShortcutsEnabled())) return;
    const row = items[current];
    const action = ACTIONS.find(([id]) => keys.scoped[id] === chord)?.[0];
    if (chord === "ArrowDown" || chord === keys.scoped["list.next"]) {
      event.preventDefault();
      focusItem(Math.min(current + 1, items.length - 1));
      return;
    }
    if (chord === "ArrowUp" || chord === keys.scoped["list.previous"]) {
      event.preventDefault();
      focusItem(Math.max(current - 1, 0));
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

  // Keep focus on the item that took the acted-on item's place.
  useEffect(() => {
    const row = items[current];
    if (row && (refocus.current || listRef.current?.contains(document.activeElement))) {
      refocus.current = false;
      refs.current.get(row.id)?.focus();
    }
  }, [items, current]);

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
      <p className="m-0 flex flex-wrap items-center gap-8 text-text-12 text-text-secondary">
        <span>{t("inbox.keys.title")}</span>
        {[
          [[keys.display["list.next"], keys.display["list.previous"]], "move"] as const,
          ...ACTIONS.map(([id, label]) => [[keys.display[id]], label] as const),
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
                  const index = items.indexOf(row);
                  const isCurrent = index === current;
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
                        onFocus={() => setSelected(index)}
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
                        <div className="flex flex-wrap gap-4">
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
