/** Renders the parsed Markdown tree with design-system styles; no HTML strings. */
import type { ReactElement, ReactNode } from "react";
import type { Locale } from "@/lib/i18n.ts";
import { resolveHref } from "@/lib/links.ts";
import type { Block, Inline } from "@/lib/markdown.ts";
import { InlineAlert, Link } from "./ui.tsx";

function inlines(items: readonly Inline[], locale: Locale): ReactNode[] {
  return items.map((item, i) => {
    switch (item.t) {
      case "strong":
        return <strong key={i}>{item.v}</strong>;
      case "code":
        return (
          <code
            key={i}
            className="font-mono text-mono-12 px-4 py-1 rounded-control bg-bg-raised border border-border-subtle"
          >
            {item.v}
          </code>
        );
      case "link": {
        const { href, external } = resolveHref(item.href, locale);
        return (
          <Link key={i} href={href} external={external}>
            {item.v}
          </Link>
        );
      }
      default:
        return item.v;
    }
  });
}

export function CodeBlock({ code, label }: { code: string; label: string }): ReactElement {
  return (
    <pre
      tabIndex={0}
      aria-label={label}
      className="m-0 p-12 overflow-x-auto rounded-card bg-bg-surface border border-border-subtle font-mono text-mono-12 leading-relaxed"
    >
      <code>{code}</code>
    </pre>
  );
}

export function Markdown({
  body,
  locale,
  codeLabel,
}: {
  body: readonly Block[];
  locale: Locale;
  codeLabel: string;
}): ReactElement {
  return (
    <>
      {body.map((block, i) => {
        switch (block.t) {
          case "h2":
            return (
              <h2
                key={i}
                id={block.id}
                className="m-0 mt-8 text-heading-20 font-semibold scroll-mt-16"
              >
                {block.v}
              </h2>
            );
          case "h3":
            return (
              <h3
                key={i}
                id={block.id}
                className="m-0 mt-4 text-heading-16 font-semibold scroll-mt-16"
              >
                {block.v}
              </h3>
            );
          case "p":
            return (
              <p key={i} className="m-0 text-text-14">
                {inlines(block.c, locale)}
              </p>
            );
          case "note":
            return (
              <InlineAlert key={i} tone="info">
                {inlines(block.c, locale)}
              </InlineAlert>
            );
          case "ul":
          case "ol": {
            const List = block.t;
            return (
              <List
                key={i}
                className={`m-0 ps-20 flex flex-col gap-4 text-text-14 ${block.t === "ul" ? "list-disc" : "list-decimal"}`}
              >
                {block.items.map((item, j) => (
                  <li key={j}>{inlines(item, locale)}</li>
                ))}
              </List>
            );
          }
          case "code":
            return <CodeBlock key={i} code={block.v} label={`${codeLabel}: ${block.lang}`} />;
          case "table":
            return (
              <div
                key={i}
                className="overflow-x-auto"
                tabIndex={0}
                role="region"
                aria-label={block.head.map((c) => c.map((x) => x.v).join("")).join(", ")}
              >
                <table className="w-full border-collapse text-text-13">
                  <thead>
                    <tr>
                      {block.head.map((cell, j) => (
                        <th
                          key={j}
                          scope="col"
                          className="text-start font-semibold p-8 border-b border-border-strong"
                        >
                          {inlines(cell, locale)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, j) => (
                      <tr key={j}>
                        {row.map((cell, k) => (
                          <td key={k} className="p-8 align-top border-b border-border-subtle">
                            {inlines(cell, locale)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          default:
            return null;
        }
      })}
    </>
  );
}

/** The outline of a page: its h2 headings as in-page links. */
export function Outline({
  body,
  label,
}: {
  body: readonly Block[];
  label: string;
}): ReactElement | null {
  const headings = body.filter((b): b is Extract<Block, { t: "h2" }> => b.t === "h2");
  if (headings.length === 0) return null;
  return (
    <nav aria-label={label} className="sticky top-0 flex flex-col gap-4 text-text-13">
      <h2 className="m-0 mb-4 text-text-12 font-semibold text-text-secondary">{label}</h2>
      <ul className="m-0 p-0 list-none flex flex-col gap-8">
        {headings.map((h) => (
          <li key={h.id}>
            <a
              href={`#${h.id}`}
              className="text-text-secondary hover:text-text-primary no-underline"
            >
              {h.v}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
