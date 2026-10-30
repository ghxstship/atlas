import type { XosClient } from "../client.ts";
import { listBeos } from "../hospitality.ts";
import { listIncidents } from "../incidents.ts";
import { fail, ok, toDataError, type Result } from "../result.ts";
import { listInspections } from "../safety-permits.ts";
import { listCallSheets, listDaySheets, listRunsOfShow } from "../show.ts";
import { untyped } from "../untyped.ts";
import { documentTranslator, formatter } from "./format.ts";
import { buildDocumentModel, fileNamePart, loadDocumentBrand } from "./generate.ts";
import {
  BOOK_SECTION_KINDS,
  MAX_BOOK_DOCUMENTS,
  type BookSectionKind,
  type DocumentModel,
  type Paper,
} from "./model.ts";
import { streamBookPdf } from "./render.ts";
import { documentProject, loadDocumentData, type LoadOptions } from "./sources.ts";
import {
  BOOK_COVER_TEMPLATES,
  bookRecordKey,
  DESCRIBE,
  type BookCoverData,
  type DocumentProject,
} from "./templates.ts";

/**
 * Document books (B7, migration 2964, ADR 0146 decision 4): a project's show documents compiled into one PDF with a
 * cover and contents. Every document is loaded as the caller, exactly as its own route loads it; one the caller
 * cannot open is left out and counted. Day sheets and call sheets go in only once published. Server only.
 */

export type DocumentBookKind = "Tour Book" | "Production Book";

export interface DocumentBook {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly kind: DocumentBookKind;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  /** In book order. */
  readonly sections: readonly BookSectionKind[];
  readonly createdAt: string;
}

interface BookRow {
  id: string;
  project_id: string;
  name: string;
  book_kind: DocumentBookKind;
  starts_on: string | null;
  ends_on: string | null;
  created_at: string;
  sections: { document_kind: string; position: number; deleted_at: string | null }[];
}

const BOOK_COLUMNS =
  "id, project_id, name, book_kind, starts_on, ends_on, created_at, sections:document_book_sections(document_kind, position, deleted_at)";

function toBook(row: BookRow): DocumentBook {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    kind: row.book_kind,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    sections: row.sections
      .filter((s) => s.deleted_at === null)
      .sort((a, b) => a.position - b.position)
      .flatMap((s) =>
        (BOOK_SECTION_KINDS as readonly string[]).includes(s.document_kind)
          ? [s.document_kind as BookSectionKind]
          : [],
      ),
    createdAt: row.created_at,
  };
}

/** The live books of a project the caller can read, by name. */
export async function listDocumentBooks(
  db: XosClient,
  input: { readonly orgId: string; readonly projectId: string },
): Promise<Result<DocumentBook[]>> {
  const { data, error } = await untyped(db)
    .from("document_books")
    .select(BOOK_COLUMNS)
    .eq("org_id", input.orgId)
    .eq("project_id", input.projectId)
    .is("deleted_at", null)
    .order("name");
  if (error) return fail(toDataError(error));
  return ok((data as unknown as BookRow[]).map(toBook));
}

/** One live book of the org, or not found (also for another org's book). */
export async function loadBook(
  db: XosClient,
  orgId: string,
  bookId: string,
): Promise<Result<DocumentBook>> {
  const { data, error } = await untyped(db)
    .from("document_books")
    .select(BOOK_COLUMNS)
    .eq("id", bookId)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  return data ? ok(toBook(data as unknown as BookRow)) : fail({ kind: "not-found" });
}

export interface BookInput {
  readonly bookId: string | null;
  readonly projectId: string;
  readonly name: string;
  readonly kind: DocumentBookKind;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  readonly sections: readonly BookSectionKind[];
}

/** Creates or changes a book and replaces its sections in order (app.save_document_book). */
export async function saveDocumentBook(
  db: XosClient,
  input: BookInput,
): Promise<Result<{ id: string }>> {
  const { data, error } = await untyped(db).rpc("save_document_book", {
    p_book_id: input.bookId,
    p_project_id: input.projectId,
    p_name: input.name,
    p_kind: input.kind,
    p_starts_on: input.startsOn,
    p_ends_on: input.endsOn,
    p_sections: [...input.sections],
  });
  if (error) return fail(toDataError(error));
  return typeof data === "string" ? ok({ id: data }) : fail({ kind: "not-found" });
}

/** Moves a book to Trash; restoreDocumentBook is its Undo. */
export async function deleteDocumentBook(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await untyped(db)
    .from("document_books")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return (data as unknown[]).length === 1 ? ok(null) : fail({ kind: "not-found" });
}

export async function restoreDocumentBook(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await untyped(db)
    .from("document_books")
    .update({ deleted_at: null })
    .eq("id", id)
    .not("deleted_at", "is", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return (data as unknown[]).length === 1 ? ok(null) : fail({ kind: "not-found" });
}

/** One document a book holds: its kind, id and the local day it is filed under (null for once-only kinds). */
export interface BookDocument {
  readonly kind: BookSectionKind;
  readonly id: string;
  readonly day: string | null;
}

export interface BookSelection {
  readonly documents: readonly BookDocument[];
  /** Day and call sheets in the range that are not yet published. */
  readonly unpublished: number;
}

/** The calendar day of an instant in a time zone, as YYYY-MM-DD (A71). */
export function zoneDay(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

const inRange = (book: DocumentBook, day: string | null) =>
  day === null || book.startsOn === null || book.endsOn === null
    ? true
    : day >= book.startsOn && day <= book.endsOn;

/**
 * The documents of each section of a book, in book order (ADR 0146 decision 4): a Tour Book by day, then section
 * position; a Production Book by section position, then day. Days are the project's local days; day and call sheets
 * go in only once published; the final cost report and the wrap-up go in once, under the project's id.
 */
export async function bookDocuments(
  db: XosClient,
  orgId: string,
  book: DocumentBook,
  project: DocumentProject,
): Promise<Result<BookSelection>> {
  const range = {
    orgId,
    projectId: project.id,
    ...(book.startsOn ? { from: book.startsOn } : {}),
    ...(book.endsOn ? { to: book.endsOn } : {}),
  };
  const docs: BookDocument[] = [];
  let unpublished = 0;
  for (const kind of book.sections) {
    switch (kind) {
      case "day-sheet":
      case "call-sheet": {
        const found =
          kind === "day-sheet" ? await listDaySheets(db, range) : await listCallSheets(db, range);
        if (!found.ok) return found;
        for (const s of found.data) {
          if (s.publishedAt === null) unpublished += 1;
          else docs.push({ kind, id: s.id, day: s.day });
        }
        break;
      }
      case "run-of-show": {
        const found = await listRunsOfShow(db, range);
        if (!found.ok) return found;
        for (const r of found.data) docs.push({ kind, id: r.id, day: r.showDate });
        break;
      }
      case "beo": {
        const found = await listBeos(db, { orgId, projectId: project.id });
        if (!found.ok) return found;
        for (const b of found.data) {
          const day = zoneDay(b.eventAt, project.timeZone);
          if (inRange(book, day)) docs.push({ kind, id: b.id, day });
        }
        break;
      }
      case "inspection-report": {
        const found = await listInspections(db, { orgId, projectId: project.id });
        if (!found.ok) return found;
        for (const i of found.data) {
          const day = zoneDay(i.inspectedAt, project.timeZone);
          if (inRange(book, day)) docs.push({ kind, id: i.id, day });
        }
        break;
      }
      case "incident-report": {
        const found = await listIncidents(db, { orgId, projectId: project.id });
        if (!found.ok) return found;
        for (const i of found.data) {
          const day = zoneDay(i.occurredAt, project.timeZone);
          if (inRange(book, day)) docs.push({ kind, id: i.id, day });
        }
        break;
      }
      case "final-cost-report":
      case "wrap-up-report":
        docs.push({ kind, id: project.id, day: null });
        break;
    }
  }
  const position = new Map(book.sections.map((k, i) => [k, i]));
  const byDay = (a: BookDocument, b: BookDocument) =>
    (a.day ?? "9999-12-31").localeCompare(b.day ?? "9999-12-31");
  const bySection = (a: BookDocument, b: BookDocument) =>
    (position.get(a.kind) ?? 0) - (position.get(b.kind) ?? 0);
  const sorted = docs
    .map((d, i) => ({ d, i }))
    .sort(
      (a, b) =>
        (book.kind === "Tour Book"
          ? byDay(a.d, b.d) || bySection(a.d, b.d)
          : bySection(a.d, b.d) || byDay(a.d, b.d)) || a.i - b.i,
    )
    .map(({ d }) => d);
  return ok({ documents: sorted, unpublished });
}

/** How many documents a book would hold now, for the Books panel (its Download is off above MAX_BOOK_DOCUMENTS). */
export async function countBookDocuments(
  db: XosClient,
  orgId: string,
  book: DocumentBook,
): Promise<Result<{ documents: number; unpublished: number }>> {
  const project = await documentProject(db, orgId, book.projectId);
  if (!project.ok) return project;
  const selection = await bookDocuments(db, orgId, book, project.data);
  if (!selection.ok) return selection;
  return ok({
    documents: selection.data.documents.length,
    unpublished: selection.data.unpublished,
  });
}

export interface BookGenerateInput {
  readonly db: XosClient;
  readonly orgId: string;
  readonly orgName: string;
  readonly bookId: string;
  readonly locale: string;
  /** The `documents` namespace of the caller's catalog. */
  readonly messages: unknown;
  readonly paper: Paper;
  /** The link a document's QR code opens: the record in Atlas. */
  readonly recordUrl: (record: {
    readonly kind: BookSectionKind;
    readonly id: string;
    readonly recordKey: string;
    readonly projectKey: string | null;
  }) => string;
  /** The link the cover's QR code opens: the book on the project's Documents tab. */
  readonly bookUrl: (book: { readonly id: string; readonly projectKey: string }) => string;
  /** The wrap-up's reader reach and units (sources.ts). */
  readonly load?: Pick<LoadOptions, "ledgerRead" | "unitPreference">;
  readonly now?: Date;
}

export interface GeneratedBook {
  readonly stream: ReadableStream<Uint8Array>;
  readonly fileName: string;
  readonly rendered: number;
  /** Documents the caller could not open, left out. */
  readonly skipped: number;
}

/**
 * A book's PDF, streamed (B7): the book and its documents read as the caller, the cover built from
 * BOOK_COVER_TEMPLATES with its contents, and the render of render.ts's streamBookPdf. Refuses a book of more than
 * MAX_BOOK_DOCUMENTS documents ('invalid', the route's 413); a book of another org, or one the caller cannot read,
 * is not found.
 */
export async function generateBook(input: BookGenerateInput): Promise<Result<GeneratedBook>> {
  const book = await loadBook(input.db, input.orgId, input.bookId);
  if (!book.ok) return book;
  const project = await documentProject(input.db, input.orgId, book.data.projectId);
  if (!project.ok) return project;
  const selection = await bookDocuments(input.db, input.orgId, book.data, project.data);
  if (!selection.ok) return selection;
  if (selection.data.documents.length > MAX_BOOK_DOCUMENTS) {
    return fail({
      kind: "invalid",
      message: `A book holds at most ${MAX_BOOK_DOCUMENTS} documents; narrow its dates.`,
    });
  }
  const now = input.now ?? new Date();
  const t = documentTranslator(input.messages);
  const brand = await loadDocumentBrand(input.db, input.orgId, input.orgName, (name) =>
    t("facts.logoAlt", { name }),
  );
  const options = {
    locale: input.locale,
    messages: input.messages,
    brand,
    now,
    paper: input.paper,
  };
  const sections: DocumentModel[] = [];
  let skipped = 0;
  for (const doc of selection.data.documents) {
    const data = await loadDocumentData(input.db, input.orgId, doc.kind, doc.id, input.load ?? {});
    if (!data.ok) {
      if (data.error.kind === "not-found") {
        skipped += 1;
        continue;
      }
      return data;
    }
    const { recordKey } = DESCRIBE[doc.kind](data.data as never, now);
    sections.push(
      buildDocumentModel(doc.kind, data.data as never, {
        ...options,
        recordUrl: input.recordUrl({
          kind: doc.kind,
          id: doc.id,
          recordKey,
          projectKey: project.data.key || null,
        }),
      }),
    );
  }
  if (sections.length === 0) return fail({ kind: "not-found" });
  const cover = bookCoverModel(
    {
      project: project.data,
      book: book.data,
      contents: sections.map((m) => ({ title: m.title, recordKey: m.facts.recordKey, page: 0 })),
      unreadable: skipped,
      unpublished: selection.data.unpublished,
    },
    {
      locale: input.locale,
      messages: input.messages,
      brand,
      now,
      paper: input.paper,
      recordUrl: input.bookUrl({ id: book.data.id, projectKey: project.data.key }),
    },
  );
  return ok({
    stream: streamBookPdf(cover, sections, {
      paper: input.paper,
      title: book.data.name,
      lang: input.locale,
    }),
    fileName: `book-${fileNamePart(cover.facts.recordKey) || "book"}-${input.paper}.pdf`,
    rendered: sections.length,
    skipped,
  });
}

/** The cover's model (pure, for tests and the veraPDF check): the version in force when the book was created. */
export function bookCoverModel(
  data: BookCoverData,
  options: {
    readonly locale: string;
    readonly messages: unknown;
    readonly brand: DocumentModel["brand"];
    readonly now: Date;
    readonly paper: Paper;
    readonly recordUrl: string;
  },
): DocumentModel {
  const t = documentTranslator(options.messages);
  const f = formatter(options.locale, data.project.timeZone, t);
  const at = Date.parse(data.book.createdAt);
  const template =
    [...BOOK_COVER_TEMPLATES]
      .sort((a, b) => a.version - b.version)
      .filter((v) => Number.isNaN(at) || Date.parse(v.effectiveFrom) <= at)
      .pop() ?? (BOOK_COVER_TEMPLATES[0] as (typeof BOOK_COVER_TEMPLATES)[number]);
  const out = template.build(data, { t, f, generatedAt: options.now, paper: options.paper });
  const recordKey = bookRecordKey(data.project.key, data.book.id);
  return {
    kind: "document-book",
    lang: options.locale,
    title: out.title,
    brand: options.brand,
    facts: {
      recordKey,
      templateVersion: template.version,
      generatedAt: f.dateTime(options.now.toISOString()),
      generatedAtIso: options.now.toISOString(),
      recordUrl: options.recordUrl,
      labels: {
        recordKey: t("facts.recordKey"),
        version: t("facts.version"),
        generatedAt: t("facts.generatedAt"),
        qrAlt: t("facts.qrAlt", { key: recordKey }),
        page: (page, total) => t("facts.page", { page, total }),
      },
    },
    blocks: out.blocks,
  };
}
