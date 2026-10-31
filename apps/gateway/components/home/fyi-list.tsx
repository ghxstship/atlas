"use client";

import { Button } from "@xos/ui";
import type { Route } from "next";
import NextLink from "next/link";
import { useRef, useState, useTransition, type KeyboardEvent } from "react";
import { OutcomeAlert } from "@/components/actions/action-button";
import { fyiDoneAction, fyiSnoozeAction } from "@/lib/actions/one-tap";
import { focusAfterLeaving } from "./fyi-focus";

export interface FyiRow {
  readonly id: string;
  /** The item's sentence, already in the person's language. */
  readonly text: string;
  /** The Gateway page it opens, when it names one. */
  readonly href: string | null;
  /** When it arrived, already formatted. */
  readonly when: string;
  readonly unread: boolean;
  /** Names of the row's buttons for assistive technology, naming the item. */
  readonly doneLabel: string;
  readonly snoozeLabel: string;
}

export interface FyiLabels {
  readonly title: string;
  readonly done: string;
  readonly snooze: string;
  readonly keys: string;
  readonly new: string;
  /** Said once the last item leaves; it takes the focus. */
  readonly empty: string;
}

/**
 * Gateway Home's For Your Information list (A127; Section 11.10 rule 5, one inbox model): notifications that need
 * nothing from the person, each with Done and Snooze. From the keyboard, J and K (or the arrow keys) move between
 * items, E marks the selected one Done and H snoozes it for a day; the next item takes the focus, so a run of E
 * clears the list, and once the last one leaves the empty-state sentence takes it. An item leaves at once and comes
 * back if the server refuses.
 */
export function FyiList({ rows, labels }: { rows: readonly FyiRow[]; labels: FyiLabels }) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [active, setActive] = useState(0);
  const [outcome, setOutcome] = useState<string | undefined>(undefined);
  const [, startTransition] = useTransition();
  const items = useRef<(HTMLLIElement | null)[]>([]);
  const empty = useRef<HTMLParagraphElement | null>(null);
  const visible = rows.filter((r) => !hidden.has(r.id));
  const current = Math.min(active, Math.max(visible.length - 1, 0));

  const focus = (index: number) => {
    setActive(index);
    items.current[index]?.focus();
  };

  const act = (row: FyiRow, index: number, kind: "done" | "snooze") => {
    setOutcome(undefined);
    setHidden((h) => new Set([...h, row.id]));
    // The next item takes the place of the one that left; after the last one, the empty-state sentence does.
    const next = focusAfterLeaving(index, visible.length);
    setActive(next ?? 0);
    requestAnimationFrame(() => (next === null ? empty.current : items.current[next])?.focus());
    startTransition(async () => {
      const result = kind === "done" ? await fyiDoneAction(row.id) : await fyiSnoozeAction(row.id);
      if (!result.ok) {
        setHidden((h) => new Set([...h].filter((id) => id !== row.id)));
        setOutcome(result.outcome);
      }
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>, row: FyiRow, index: number) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const key = event.key.toLowerCase();
    if (key === "e" || key === "h") {
      event.preventDefault();
      act(row, index, key === "e" ? "done" : "snooze");
    } else if (key === "j" || event.key === "ArrowDown") {
      event.preventDefault();
      focus(Math.min(index + 1, visible.length - 1));
    } else if (key === "k" || event.key === "ArrowUp") {
      event.preventDefault();
      focus(Math.max(index - 1, 0));
    }
  };

  if (visible.length === 0 && outcome === undefined)
    return (
      <p ref={empty} tabIndex={-1} className="m-0 text-text-14 text-text-secondary outline-none">
        {labels.empty}
      </p>
    );
  return (
    <div className="flex flex-col gap-8">
      <OutcomeAlert outcome={outcome} />
      <p id="fyi-keys" className="m-0 text-text-12 text-text-secondary">
        {labels.keys}
      </p>
      <ul
        aria-label={labels.title}
        aria-describedby="fyi-keys"
        className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle bg-bg-raised p-0"
      >
        {visible.map((row, index) => (
          <li
            key={row.id}
            ref={(el) => {
              items.current[index] = el;
            }}
            tabIndex={index === current ? 0 : -1}
            aria-keyshortcuts="E H J K"
            onFocus={() => setActive(index)}
            onKeyDown={(e) => onKeyDown(e, row, index)}
            className="flex flex-wrap items-center gap-12 px-16 py-12 outline-none focus-visible:outline-solid focus-visible:outline-stroke-focus focus-visible:outline-focus-ring"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              {row.href ? (
                <NextLink href={row.href as Route} className="font-medium text-text-primary">
                  {row.text}
                </NextLink>
              ) : (
                <span className="font-medium">{row.text}</span>
              )}
              <span className="text-text-12 text-text-secondary">
                {row.when}
                {row.unread ? ` · ${labels.new}` : ""}
              </span>
            </div>
            <div className="flex gap-8">
              <Button
                variant="secondary"
                size="sm"
                aria-label={row.doneLabel}
                onClick={() => act(row, index, "done")}
              >
                {labels.done}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label={row.snoozeLabel}
                onClick={() => act(row, index, "snooze")}
              >
                {labels.snooze}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
