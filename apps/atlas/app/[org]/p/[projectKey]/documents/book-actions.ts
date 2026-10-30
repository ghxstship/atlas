"use server";

import {
  deleteDocumentBook,
  restoreDocumentBook,
  saveDocumentBook,
} from "@xos/data/documents/books";
import { BOOK_SECTION_KINDS } from "@xos/data/documents/model";
import type { DataError, Result } from "@xos/data/result";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getProjectContextFor } from "@/lib/projects/context";

/**
 * Books on the project Documents tab (B7, migration 2964, ADR 0146 decision 4): save a book and its ordered
 * sections, delete it to Trash and undo. app.save_document_book and row level security decide; a refusal comes
 * back as its rule, which the panel shows from `knowledge.books.errors`.
 */

export type BookActionResult =
  { readonly ok: true; readonly id?: string } | { readonly ok: false; readonly key: string };

const RULES = new Set([
  "document_book_name",
  "document_book_sections",
  "document_book_kind_sections",
  "document_book_dates",
]);

function keyOf(error: DataError): string {
  if (error.kind === "refusal") return RULES.has(error.rule) ? error.rule : "refused";
  if (error.kind === "not-found") return "notFound";
  if (error.kind === "invalid") return "invalid";
  return "unexpected";
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Book = z.object({
  org: z.string().min(1).max(100),
  projectKey: z.string().min(1).max(40),
  bookId: z.uuid().nullable(),
  name: z.string().max(200),
  kind: z.enum(["Tour Book", "Production Book"]),
  startsOn: day.nullable(),
  endsOn: day.nullable(),
  sections: z.array(z.enum(BOOK_SECTION_KINDS)).max(BOOK_SECTION_KINDS.length),
});

async function finish(
  input: { org: string; projectKey: string },
  run: (db: Parameters<typeof saveDocumentBook>[0], projectId: string) => Promise<Result<unknown>>,
): Promise<BookActionResult> {
  const ctx = await getProjectContextFor({ org: input.org, projectKey: input.projectKey });
  if (!ctx) return { ok: false, key: "notFound" };
  const result = await run(ctx.org.viewer.db, ctx.project.id);
  if (!result.ok) return { ok: false, key: keyOf(result.error) };
  revalidatePath(`/${input.org}/p/${input.projectKey}/documents`);
  const id = (result.data as { id?: unknown } | null)?.id;
  return typeof id === "string" ? { ok: true, id } : { ok: true };
}

export async function saveDocumentBookAction(raw: unknown): Promise<BookActionResult> {
  const parsed = Book.safeParse(raw);
  if (!parsed.success) return { ok: false, key: "invalid" };
  const b = parsed.data;
  return finish(b, (db, projectId) =>
    saveDocumentBook(db, {
      bookId: b.bookId,
      projectId,
      name: b.name,
      kind: b.kind,
      startsOn: b.startsOn,
      endsOn: b.endsOn,
      sections: b.sections,
    }),
  );
}

const Target = z.object({
  org: z.string().min(1).max(100),
  projectKey: z.string().min(1).max(40),
  id: z.uuid(),
});

/** Moves a book to Trash; restoreDocumentBookAction is its Undo. */
export async function deleteDocumentBookAction(raw: unknown): Promise<BookActionResult> {
  const parsed = Target.safeParse(raw);
  if (!parsed.success) return { ok: false, key: "invalid" };
  return finish(parsed.data, (db) => deleteDocumentBook(db, parsed.data.id));
}

export async function restoreDocumentBookAction(raw: unknown): Promise<BookActionResult> {
  const parsed = Target.safeParse(raw);
  if (!parsed.success) return { ok: false, key: "invalid" };
  return finish(parsed.data, (db) => restoreDocumentBook(db, parsed.data.id));
}
