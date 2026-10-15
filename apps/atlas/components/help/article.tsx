import type { Block, Inline } from "@/help/model";

/**
 * Renders a help article body from the parsed Markdown subset (help/model.ts) as plain elements:
 * no HTML strings. `help:<slug>` links open the article in the panel; other links are ordinary.
 */
export function ArticleBody({
  blocks,
  onArticle,
}: {
  blocks: readonly Block[];
  onArticle: (slug: string) => void;
}) {
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
              className="cursor-pointer border-0 bg-transparent p-0 text-start font-medium text-accent-text underline"
            >
              {part.v}
            </button>
          );
        }
        return (
          <a key={i} href={part.href} className="font-medium text-accent-text underline">
            {part.v}
          </a>
        );
      }
      return <span key={i}>{part.v}</span>;
    });
  return (
    <div className="flex flex-col gap-8 text-text-13 text-text-primary">
      {blocks.map((block, i) => {
        if (block.t === "h2" || block.t === "h3") {
          return block.t === "h2" ? (
            <h3 key={i} className="m-0 mt-8 text-heading-16 font-semibold">
              {block.v}
            </h3>
          ) : (
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
