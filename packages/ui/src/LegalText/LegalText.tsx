import type { ReactElement, ReactNode } from "react";
import {
  LEGAL_HISTORY_ID,
  type LegalBlock,
  type LegalInline,
  type LegalVersion,
} from "./legal-markdown.ts";

/** Where a document's path leads in this app; null leaves the text as it is written. */
export type LegalHref = (slug: string) => string | null;

const LINK = "text-accent-text underline";
const CODE =
  "font-mono text-mono-12 px-4 py-1 rounded-control bg-bg-raised border border-border-subtle";
const CELL_PAD = "p-8 align-top";
/** Past two columns, a table keeps a readable width and scrolls in its region on a phone. */
const MANY_COLUMNS = 3;

const HEADING_CLASS = {
  1: "m-0 text-heading-24 font-semibold",
  2: "m-0 mt-16 text-heading-20 font-semibold scroll-mt-16",
  3: "m-0 mt-8 text-heading-16 font-semibold scroll-mt-16",
  4: "m-0 mt-8 text-text-14 font-semibold scroll-mt-16",
  5: "m-0 mt-8 text-text-14 font-semibold scroll-mt-16",
  6: "m-0 mt-8 text-text-14 font-semibold scroll-mt-16",
} as const;

function Inlines({ parts, hrefFor }: { parts: readonly LegalInline[]; hrefFor: LegalHref }) {
  return parts.map((part, i): ReactNode => {
    switch (part.t) {
      case "text":
        return part.v;
      case "strong":
        return (
          <strong key={i}>
            <Inlines parts={part.c} hrefFor={hrefFor} />
          </strong>
        );
      case "em":
        return (
          <em key={i}>
            <Inlines parts={part.c} hrefFor={hrefFor} />
          </em>
        );
      case "code":
        return (
          <code key={i} className={CODE}>
            {part.v}
          </code>
        );
      case "link":
        return (
          <a key={i} href={part.href} rel="noreferrer" className={LINK}>
            <Inlines parts={part.c} hrefFor={hrefFor} />
          </a>
        );
      case "mail":
        return (
          <a key={i} href={`mailto:${part.v}`} className={LINK}>
            {part.v}
          </a>
        );
      case "section":
        return (
          <a key={i} href={`#${part.id}`} className={LINK}>
            {part.v}
          </a>
        );
      case "document": {
        const href = hrefFor(part.slug);
        return href === null ? (
          part.v
        ) : (
          <a key={i} href={href} className={LINK}>
            {part.v}
          </a>
        );
      }
    }
  });
}

function Blocks({ blocks, hrefFor }: { blocks: readonly LegalBlock[]; hrefFor: LegalHref }) {
  return blocks.map((block, i): ReactNode => {
    switch (block.t) {
      case "heading": {
        const Heading = `h${block.level}` as const;
        return (
          <Heading key={i} id={block.id} className={HEADING_CLASS[block.level]}>
            {block.v}
          </Heading>
        );
      }
      case "p":
        return (
          <p key={i} id={block.id} className="m-0 text-text-14 scroll-mt-16">
            <Inlines parts={block.c} hrefFor={hrefFor} />
          </p>
        );
      case "quote":
        return (
          <blockquote
            key={i}
            className="m-0 flex flex-col gap-8 border-s-2 border-border-strong ps-12"
          >
            <Blocks blocks={block.c} hrefFor={hrefFor} />
          </blockquote>
        );
      case "list": {
        const List = block.ordered ? "ol" : "ul";
        return (
          <List
            key={i}
            {...(block.ordered && block.start !== 1 ? { start: block.start } : {})}
            className={`m-0 flex flex-col gap-4 ps-20 text-text-14 ${block.ordered ? "list-decimal" : "list-disc"}`}
          >
            {block.items.map((item, j) => (
              <li key={j}>
                <Inlines parts={item.c} hrefFor={hrefFor} />
                {item.children.length > 0 ? (
                  <div className="mt-4 flex flex-col gap-4">
                    <Blocks blocks={item.children} hrefFor={hrefFor} />
                  </div>
                ) : null}
              </li>
            ))}
          </List>
        );
      }
      case "table":
        // In the tab order so a keyboard can scroll it; this page runs no script to measure it.
        return (
          <div
            key={i}
            role="region"
            aria-label={block.label}
            tabIndex={0}
            className="overflow-x-auto"
          >
            <table
              className={`w-full border-collapse text-text-13 ${block.head.length >= MANY_COLUMNS ? "min-w-(--layout-form)" : ""}`.trim()}
            >
              <thead>
                <tr>
                  {block.head.map((cell, j) => (
                    <th
                      key={j}
                      scope="col"
                      className="p-8 text-start align-bottom font-semibold border-b border-border-strong"
                    >
                      <Inlines parts={cell} hrefFor={hrefFor} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, j) => (
                  <tr key={j}>
                    {row.map((cell, k) => (
                      <td key={k} className={`${CELL_PAD} border-b border-border-subtle`}>
                        <Inlines parts={cell} hrefFor={hrefFor} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

/**
 * A legal document's text as plain elements, for a server component: no hooks and no script, so it
 * adds nothing to the browser's bundle. The text is written in English whatever the page's locale,
 * so it says so to assistive technology, and the pseudo-locale check treats it as content.
 */
export function LegalText({
  blocks,
  hrefFor,
}: {
  blocks: readonly LegalBlock[];
  hrefFor: LegalHref;
}): ReactElement {
  return (
    <div data-pseudo-exempt lang="en-US" dir="ltr" className="contents break-words">
      <Blocks blocks={blocks} hrefFor={hrefFor} />
    </div>
  );
}

function topHeadings(blocks: readonly LegalBlock[]) {
  return blocks.filter((b): b is Extract<LegalBlock, { t: "heading" }> => {
    return b.t === "heading" && b.level === 2;
  });
}

function OutlineLinks({ blocks }: { blocks: readonly LegalBlock[] }) {
  return (
    <ul lang="en-US" dir="ltr" data-pseudo-exempt className="m-0 flex list-none flex-col gap-8 p-0">
      {topHeadings(blocks).map((h) => (
        <li key={h.id}>
          <a href={`#${h.id}`} className="text-text-secondary hover:text-text-primary no-underline">
            {h.v}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** The fewest headings worth an outline; a shorter document is read in one look. */
const OUTLINE_MIN = 3;

/** The outline for TemplateDocument's sidebar: the document's sections as in-page links. */
export function LegalOutline({
  blocks,
  label,
}: {
  blocks: readonly LegalBlock[];
  label: string;
}): ReactElement | null {
  if (topHeadings(blocks).length < OUTLINE_MIN) return null;
  return (
    <nav
      aria-label={label}
      className="sticky top-0 flex max-h-dvh flex-col gap-8 overflow-y-auto text-text-13"
    >
      <p className="m-0 text-text-12 font-semibold text-text-secondary">{label}</p>
      <OutlineLinks blocks={blocks} />
    </nav>
  );
}

/** The same outline in the flow of the page, closed until asked for; it needs no script. */
export function LegalContents({
  blocks,
  label,
}: {
  blocks: readonly LegalBlock[];
  label: string;
}): ReactElement | null {
  if (topHeadings(blocks).length < OUTLINE_MIN) return null;
  return (
    <nav aria-label={label} className="text-text-13">
      <details className="rounded-card border border-border-subtle bg-bg-surface p-12">
        <summary className="cursor-pointer font-semibold">{label}</summary>
        <div className="mt-8">
          <OutlineLinks blocks={blocks} />
        </div>
      </details>
    </nav>
  );
}

/**
 * The document's versions, newest first, each with its version number and whether and since when
 * it is in effect (`describe`, in the page's language) and its summary of changes, which is written
 * in English with the text. Terms of Service 15 promises this list.
 */
export function LegalHistory({
  history,
  title,
  describe,
}: {
  history: readonly LegalVersion[];
  title: string;
  describe: (version: LegalVersion) => string;
}): ReactElement | null {
  if (history.length === 0) return null;
  return (
    <section aria-labelledby={LEGAL_HISTORY_ID} className="flex flex-col gap-8">
      <h2 id={LEGAL_HISTORY_ID} className={HEADING_CLASS[2]}>
        {title}
      </h2>
      <ol className="m-0 flex list-none flex-col gap-12 p-0 text-text-14">
        {history.map((v) => (
          <li key={v.version} className="flex flex-col gap-4">
            <span className="font-semibold">{describe(v)}</span>
            <span data-pseudo-exempt lang="en-US" dir="ltr" className="text-text-secondary">
              {v.summary}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
