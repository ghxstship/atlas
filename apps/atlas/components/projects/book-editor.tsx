"use client";

import { Button, Dialog, InlineAlert, Input, Select } from "@xos/ui";
import { undoStack } from "@xos/ui/undo";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import {
  deleteDocumentBookAction,
  restoreDocumentBookAction,
  saveDocumentBookAction,
  type BookActionResult,
} from "@/app/[org]/p/[projectKey]/documents/book-actions";

type Option = { readonly value: string; readonly label: string };

export interface BookValues {
  readonly id: string;
  readonly name: string;
  readonly kind: "Tour Book" | "Production Book";
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  readonly sections: readonly string[];
}

export interface BookEditorLabels {
  readonly newBook: string;
  readonly edit: string;
  readonly editLabel: string;
  readonly delete: string;
  readonly deleteLabel: string;
  readonly trashed: string;
  readonly title: string;
  readonly editTitle: string;
  readonly name: string;
  readonly kind: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly datesHelp: string;
  readonly sections: string;
  readonly sectionsHelp: string;
  readonly moveUp: string;
  readonly moveDown: string;
  readonly save: string;
  readonly cancel: string;
  readonly kinds: readonly Option[];
  /** Every section kind a book may hold, in the default order. */
  readonly sectionKinds: readonly Option[];
  /** Section kinds a Tour Book leaves out. */
  readonly productionOnly: readonly string[];
  /** Error copy by key (a refusal rule, notFound, invalid, unexpected). */
  readonly errors: Readonly<Record<string, string>>;
}

/**
 * New book, Edit and Delete on the project Documents tab (B7, ADR 0146 decision 4): name, kind, dates and the
 * sections in order (checked, moved up or down), saved by app.save_document_book; Delete moves the book to Trash
 * with the 8-second Undo (A119, A121). Loaded on demand (components/lazy-ui/book-editor.tsx); labels come from the
 * server.
 */
export function BookEditor({
  org,
  projectKey,
  book,
  labels,
}: {
  org: string;
  projectKey: string;
  /** Null for New book. */
  book: BookValues | null;
  labels: BookEditorLabels;
}) {
  const id = useId();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(book?.name ?? "");
  const [kind, setKind] = useState<BookValues["kind"]>(book?.kind ?? "Tour Book");
  const [startsOn, setStartsOn] = useState(book?.startsOn ?? "");
  const [endsOn, setEndsOn] = useState(book?.endsOn ?? "");
  const all = labels.sectionKinds.map((o) => o.value);
  const [order, setOrder] = useState<string[]>(() => [
    ...(book?.sections ?? []),
    ...all.filter((k) => !(book?.sections ?? []).includes(k)),
  ]);
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(book?.sections ?? ["day-sheet", "call-sheet", "run-of-show"]),
  );
  const labelOf = (value: string) =>
    labels.sectionKinds.find((o) => o.value === value)?.label ?? value;
  const shown = order.filter(
    (k) => kind === "Production Book" || !labels.productionOnly.includes(k),
  );
  const move = (k: string, by: -1 | 1) =>
    setOrder((current) => {
      const at = current.indexOf(k);
      const to = at + by;
      if (at < 0 || to < 0 || to >= current.length) return current;
      const next = [...current];
      next.splice(at, 1);
      next.splice(to, 0, k);
      return next;
    });
  const answer = (result: BookActionResult) => {
    if (!result.ok) {
      setError(labels.errors[result.key] ?? labels.errors["unexpected"] ?? result.key);
      return false;
    }
    router.refresh();
    return true;
  };
  const save = () =>
    start(async () => {
      setError(null);
      const ok = answer(
        await saveDocumentBookAction({
          org,
          projectKey,
          bookId: book?.id ?? null,
          name,
          kind,
          startsOn: startsOn || null,
          endsOn: endsOn || null,
          sections: shown.filter((k) => picked.has(k)),
        }),
      );
      if (ok) setOpen(false);
    });
  const remove = () =>
    start(async () => {
      if (!book) return;
      const target = { org, projectKey, id: book.id };
      if (!answer(await deleteDocumentBookAction(target))) return;
      const asUndo = async (result: Promise<BookActionResult>) => {
        const r = await result;
        router.refresh();
        return r.ok
          ? ({ ok: true } as const)
          : ({ ok: false, message: labels.errors[r.key] ?? r.key } as const);
      };
      undoStack.push({
        label: labels.trashed,
        undo: () => asUndo(restoreDocumentBookAction(target)),
        redo: () => asUndo(deleteDocumentBookAction(target)),
      });
    });
  return (
    <span className="inline-flex flex-wrap items-center gap-8">
      <Button
        size="sm"
        variant={book ? "ghost" : "secondary"}
        aria-label={book ? labels.editLabel : undefined}
        onClick={() => setOpen(true)}
      >
        {book ? labels.edit : labels.newBook}
      </Button>
      {book ? (
        <Button
          size="sm"
          variant="ghost"
          aria-label={labels.deleteLabel}
          loading={pending}
          onClick={remove}
        >
          {labels.delete}
        </Button>
      ) : null}
      {!open && error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      {open ? (
        <Dialog
          title={book ? labels.editTitle : labels.title}
          open
          onOpenChange={setOpen}
          actions={
            <>
              <Button type="button" onClick={() => setOpen(false)}>
                {labels.cancel}
              </Button>
              <Button type="button" variant="primary" loading={pending} onClick={save}>
                {labels.save}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-12" data-testid="book-editor">
            {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
            <Input
              id={`${id}-name`}
              label={labels.name}
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
            />
            <Select
              id={`${id}-kind`}
              label={labels.kind}
              value={kind}
              onChange={(e) =>
                setKind(e.target.value === "Production Book" ? "Production Book" : "Tour Book")
              }
              options={[...labels.kinds]}
            />
            <div className="flex flex-wrap gap-12">
              <Input
                id={`${id}-from`}
                type="date"
                label={labels.startsOn}
                value={startsOn}
                onChange={(e) => setStartsOn(e.target.value)}
              />
              <Input
                id={`${id}-to`}
                type="date"
                label={labels.endsOn}
                help={labels.datesHelp}
                value={endsOn}
                onChange={(e) => setEndsOn(e.target.value)}
              />
            </div>
            <fieldset className="m-0 flex flex-col gap-4 border-0 p-0">
              <legend className="mb-4 text-label-13 font-medium">{labels.sections}</legend>
              <p className="m-0 text-text-12 text-text-secondary">{labels.sectionsHelp}</p>
              <ol className="m-0 flex list-none flex-col gap-4 p-0">
                {shown.map((k, i) => (
                  <li key={k} className="flex items-center justify-between gap-8">
                    <label className="inline-flex items-center gap-8 text-text-13">
                      <input
                        type="checkbox"
                        checked={picked.has(k)}
                        onChange={(e) =>
                          setPicked((current) => {
                            const next = new Set(current);
                            if (e.target.checked) next.add(k);
                            else next.delete(k);
                            return next;
                          })
                        }
                      />
                      {labelOf(k)}
                    </label>
                    <span className="inline-flex gap-4">
                      <Button
                        size="sm"
                        variant="ghost"
                        icon="ArrowUp"
                        aria-label={`${labels.moveUp}: ${labelOf(k)}`}
                        disabled={i === 0}
                        onClick={() => move(k, -1)}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        icon="ArrowDown"
                        aria-label={`${labels.moveDown}: ${labelOf(k)}`}
                        disabled={i === shown.length - 1}
                        onClick={() => move(k, 1)}
                      />
                    </span>
                  </li>
                ))}
              </ol>
            </fieldset>
          </div>
        </Dialog>
      ) : null}
    </span>
  );
}
