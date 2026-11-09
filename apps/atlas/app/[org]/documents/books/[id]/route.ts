import { generateBook } from "@xos/data/documents/books";
import { isLocale } from "@xos/i18n";
import { loadMessages } from "@xos/i18n/load";
import { getLocale } from "next-intl/server";
import { atlasRecordPath, bookPath } from "@/lib/documents/links";
import { wrapUpLoadOptions } from "@/lib/documents/wrap-up";
import { env } from "@/lib/env";
import { observability } from "@/lib/observability";
import { getOrgContext } from "@/lib/shell/context";

/** A book of 100 documents takes a while to draw; the stream starts once the pages are counted. */
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A tour or production book as one tagged PDF/UA-1 file (B7, ADR 0146 decision 4): the cover and contents, then
 * each document, every one read with the viewer's own row level security. `?paper=a4` prints on A4, else Letter.
 * A book the viewer cannot read, or one of another org, answers 404; one of more than 100 documents answers 413.
 * Documents the viewer cannot open are left out and counted in X-Book-Skipped. The PDF is streamed.
 */
export async function GET(
  request: Request,
  { params }: RouteContext<"/[org]/documents/books/[id]">,
): Promise<Response> {
  const { org, id } = await params;
  if (!UUID.test(id)) return new Response(null, { status: 404 });
  const ctx = await getOrgContext(org);
  if (!ctx) return new Response(null, { status: 404 });
  const paper = new URL(request.url).searchParams.get("paper") === "a4" ? "a4" : "letter";
  const negotiated = await getLocale();
  const locale = isLocale(negotiated) ? negotiated : "en-US";
  const site = env().ATLAS_SITE_URL;
  const result = await generateBook({
    db: ctx.viewer.db,
    orgId: ctx.org.id,
    orgName: ctx.org.name,
    bookId: id.toLowerCase(),
    locale,
    messages: (await loadMessages(locale)).documents,
    paper,
    load: await wrapUpLoadOptions(ctx, ctx.viewer.db, locale, null),
    recordUrl: (record) =>
      new URL(atlasRecordPath(ctx.org.slug, record.kind, record), site).toString(),
    bookUrl: (book) => new URL(bookPath(ctx.org.slug, book.projectKey, book.id), site).toString(),
  });
  if (!result.ok) {
    if (result.error.kind === "not-found") return new Response(null, { status: 404 });
    if (result.error.kind === "invalid") return new Response(null, { status: 413 });
    observability.logger.error("book generation failed", { error: result.error });
    return new Response(null, { status: 500 });
  }
  return new Response(result.data.stream, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${result.data.fileName}"`,
      "Cache-Control": "private, no-store",
      "X-Book-Skipped": String(result.data.skipped),
    },
  });
}
