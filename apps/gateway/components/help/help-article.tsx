"use client";

import type { Block, Inline } from "@xos/help";
import type { Route } from "next";
import NextLink from "next/link";

/**
 * Renders a help article body from the parsed Markdown subset (@xos/help) as plain elements, never
 * HTML strings. `help:<slug>` links open that article in the panel; a Gateway path opens the page
 * and closes the panel; anything else is an ordinary link.
 */
export function HelpArticle({
  blocks,
  onArticle,
  onNavigate,
}: {
  readonly blocks: readonly Block[];
  readonly onArticle: (slug: string) => void;
  readonly onNavigate: () => void;
}) {
  const link = "font-medium text-accent-text underline";
  const inline = (parts: readonly Inline[]) =>
    parts.map((part, i) => {
      if (part.t === "strong") return <strong key={i}>{part.v}</strong>;
      if (part.t === "code") return <code key={i}>{part.v}</code>;
      if (part.t === "link") {
        if (part.href.startsWith("help:")) {
          return (
            <button
              key={i}
              type="button"
              onClick={() => onArticle(part.href.slice(5))}
              className={`cursor-pointer border-0 bg-transparent p-0 text-start ${link}`}
            >
              {part.v}
            </button>
          );
        }
        if (part.href.startsWith("/")) {
          return (
            <NextLink key={i} href={part.href as Route} onClick={onNavigate} className={link}>
              {part.v}
            </NextLink>
          );
        }
        return (
          <a key={i} href={part.href} className={link}>
            {part.v}
          </a>
        );
      }
      return <span key={i}>{part.v}</span>;
    });
  return (
    <div className="flex flex-col gap-8 text-text-13 text-text-primary">
      {blocks.map((block, i) => {
        if (block.t === "h2") {
          return (
            <h3 key={i} className="m-0 mt-8 text-heading-16 font-semibold">
              {block.v}
            </h3>
          );
        }
        if (block.t === "h3") {
          return (
            <h4 key={i} className="m-0 mt-4 text-text-13 font-semibold">
              {block.v}
            </h4>
          );
        }
        if (block.t === "p") {
          return (
            <p key={i} className="m-0">
              {inline(block.c)}
            </p>
          );
        }
        const List = block.t === "ul" ? "ul" : "ol";
        return (
          <List key={i} className="m-0 flex flex-col gap-4 ps-20">
            {block.items.map((item, j) => (
              <li key={j}>{inline(item)}</li>
            ))}
          </List>
        );
      })}
    </div>
  );
}
