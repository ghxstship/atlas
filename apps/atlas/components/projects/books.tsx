import { countBookDocuments, listDocumentBooks } from "@xos/data/documents/books";
import {
  BOOK_SECTION_KINDS,
  MAX_BOOK_DOCUMENTS,
  PRODUCTION_ONLY_SECTIONS,
} from "@xos/data/documents/model";
import { getFormatter } from "next-intl/server";
import { BookEditor } from "@/components/lazy-ui/book-editor";
import { DownloadLink, InlineAlert } from "@/components/ui";
import { bookHref } from "@/lib/documents/links";
import type { ProjectContext } from "@/lib/projects/context";
import { getTranslate, type Translate } from "@/lib/shell/translate";
import type { BookEditorLabels } from "./book-editor";

/**
 * Books on the project Documents tab (B7, ADR 0146 decision 4): each book of the project with its kind, dates and
 * how many documents it holds now, downloaded on Letter or A4. A book of more than 100 documents cannot be
 * downloaded until its dates are narrowed. Readers of the run of show see the books; holders of show.day_sheet.write
 * also get New book, Edit and Delete (with Undo), loaded on demand. Row level security decides what each lists.
 */

const P = "knowledge.books";
const RULES = [
  "document_book_name",
  "document_book_sections",
  "document_book_kind_sections",
  "document_book_dates",
  "refused",
  "notFound",
  "invalid",
  "unexpected",
] as const;

const keyOf = (value: string) => value.replace(/[^A-Za-z0-9]/g, "");

function editorLabels(t: Translate, name: string | null): BookEditorLabels {
  return {
    newBook: t(`${P}.new`),
    edit: t(`${P}.edit`),
    editLabel: t(`${P}.editLabel`, { name: name ?? "" }),
    delete: t(`${P}.delete`),
    deleteLabel: t(`${P}.deleteLabel`, { name: name ?? "" }),
    trashed: t(`${P}.trashed`, { name: name ?? "" }),
    title: t(`${P}.newTitle`),
    editTitle: t(`${P}.editTitle`),
    name: t(`${P}.name`),
    kind: t(`${P}.kind`),
    startsOn: t(`${P}.startsOn`),
    endsOn: t(`${P}.endsOn`),
    datesHelp: t(`${P}.datesHelp`),
    sections: t(`${P}.sections`),
    sectionsHelp: t(`${P}.sectionsHelp`),
    moveUp: t(`${P}.moveUp`),
    moveDown: t(`${P}.moveDown`),
    save: t(`${P}.save`),
    cancel: t(`${P}.cancel`),
    kinds: (["Tour Book", "Production Book"] as const).map((k) => ({
      value: k,
      label: t(`${P}.kinds.${keyOf(k)}`),
    })),
    sectionKinds: BOOK_SECTION_KINDS.map((k) => ({
      value: k,
      label: t(`${P}.sectionKinds.${keyOf(k)}`),
    })),
    productionOnly: PRODUCTION_ONLY_SECTIONS,
    errors: Object.fromEntries(RULES.map((r) => [r, t(`${P}.errors.${r}`)])),
  };
}

export async function BooksSection({ ctx }: { ctx: ProjectContext }) {
  if (!ctx.capabilities.has("show.run_of_show.read")) return null;
  const db = ctx.org.viewer.db;
  const orgId = ctx.org.org.id;
  const [t, format, books] = await Promise.all([
    getTranslate(),
    getFormatter(),
    listDocumentBooks(db, { orgId, projectId: ctx.project.id }),
  ]);
  if (!books.ok) return <InlineAlert tone="danger">{t("settings.loadFailed")}</InlineAlert>;
  const counts = await Promise.all(books.data.map((b) => countBookDocuments(db, orgId, b)));
  const canWrite = ctx.capabilities.has("show.day_sheet.write");
  const org = ctx.org.org.slug;
  const day = (d: string) =>
    format.dateTime(new Date(`${d}T12:00:00Z`), { dateStyle: "medium", timeZone: "UTC" });
  return (
    <section aria-labelledby="project-books" className="flex flex-col gap-12">
      <header className="flex flex-wrap items-start justify-between gap-12">
        <div className="flex flex-col gap-4">
          <h2 id="project-books" className="m-0 text-heading-16 font-semibold">
            {t(`${P}.title`)}
          </h2>
          <p className="m-0 text-text-13 text-text-secondary">{t(`${P}.description`)}</p>
        </div>
        {canWrite ? (
          <BookEditor
            org={org}
            projectKey={ctx.project.key}
            book={null}
            labels={editorLabels(t, null)}
          />
        ) : null}
      </header>
      {books.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t(`${P}.none`)}</p>
      ) : (
        <ul
          aria-label={t(`${P}.listLabel`)}
          className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0"
        >
          {books.data.map((book, i) => {
            const count = counts[i];
            const documents = count?.ok ? count.data.documents : null;
            const tooMany = documents !== null && documents > MAX_BOOK_DOCUMENTS;
            const href = bookHref(org, book.id);
            return (
              <li key={book.id} className="flex flex-col gap-8 p-12" data-testid="book">
                <div className="flex flex-wrap items-start justify-between gap-12">
                  <div className="flex min-w-0 flex-col gap-4">
                    <span className="text-label-13 font-medium">{book.name}</span>
                    <span className="text-text-12 text-text-secondary">
                      {[
                        t(`${P}.kinds.${keyOf(book.kind)}`),
                        book.startsOn && book.endsOn
                          ? t(`${P}.range`, { from: day(book.startsOn), to: day(book.endsOn) })
                          : t(`${P}.wholeProject`),
                        documents === null ? null : t(`${P}.documents`, { count: documents }),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </div>
                  <span className="inline-flex flex-wrap items-center gap-8">
                    {tooMany ? (
                      <span className="text-text-12 text-warning-text">
                        {t(`${P}.tooMany`, { max: MAX_BOOK_DOCUMENTS })}
                      </span>
                    ) : (
                      <>
                        <DownloadLink href={href}>{t(`${P}.download`)}</DownloadLink>
                        <DownloadLink href={`${href}?paper=a4`}>
                          {t(`${P}.downloadA4`)}
                        </DownloadLink>
                      </>
                    )}
                    {canWrite ? (
                      <BookEditor
                        org={org}
                        projectKey={ctx.project.key}
                        book={{
                          id: book.id,
                          name: book.name,
                          kind: book.kind,
                          startsOn: book.startsOn,
                          endsOn: book.endsOn,
                          sections: book.sections,
                        }}
                        labels={editorLabels(t, book.name)}
                      />
                    ) : null}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
