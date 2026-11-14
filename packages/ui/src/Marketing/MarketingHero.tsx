import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { type MarketingHeroProps } from "./Marketing.types.ts";

/**
 * The opening of a public page, or with `compact` its closing call to action. The default hero
 * holds the page's one h1 at display-64; the compact hero is an h2 at display-48.
 */
export function MarketingHero({
  id,
  variant = "default",
  eyebrow,
  title,
  lead,
  actions,
  note,
  media,
  headingLevel,
}: MarketingHeroProps): ReactElement {
  const compact = variant === "compact";
  const Heading = `h${headingLevel ?? (compact ? 2 : 1)}` as const;
  return (
    <section
      id={id}
      className={cx(
        "xos-mkt-hero",
        compact && "xos-mkt-hero-compact",
        !media && "xos-mkt-hero-solo",
      )}
    >
      <div className="xos-mkt-wrap xos-mkt-hero-grid">
        <div className="xos-mkt-hero-copy">
          {eyebrow ? <p className="xos-mkt-eyebrow">{eyebrow}</p> : null}
          <Heading className={compact ? "xos-mkt-display-48" : "xos-mkt-display-64"}>
            {title}
          </Heading>
          {lead ? <p className="xos-mkt-lead">{lead}</p> : null}
          {actions ? <div className="xos-mkt-actions">{actions}</div> : null}
          {note ? <p className="xos-mkt-note">{note}</p> : null}
        </div>
        {media ? <div className="xos-mkt-hero-media">{media}</div> : null}
      </div>
    </section>
  );
}
