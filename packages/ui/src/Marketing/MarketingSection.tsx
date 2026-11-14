import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { Icon } from "../Icon/Icon.tsx";
import { type MarketingSectionProps } from "./Marketing.types.ts";

/**
 * One section of a public page: eyebrow, heading, the direct answer that opens it, then its
 * content. The heading labels the section when the section has an id.
 */
export function MarketingSection({
  id,
  eyebrow,
  glyph,
  title,
  lead,
  badge,
  tone = "canvas",
  align = "start",
  headingLevel = 2,
  children,
}: MarketingSectionProps): ReactElement {
  const Heading = `h${headingLevel}` as const;
  const titleId = id ? `${id}-title` : undefined;
  return (
    <section
      id={id}
      aria-labelledby={titleId}
      className={cx(
        "xos-mkt-section",
        tone === "surface" && "xos-mkt-section-surface",
        align === "center" && "xos-mkt-center",
      )}
    >
      <div className="xos-mkt-wrap">
        <header className="xos-mkt-section-head">
          {eyebrow ? (
            <p className="xos-mkt-eyebrow">
              {glyph ? <Icon name={glyph} size={14} /> : null}
              {eyebrow}
            </p>
          ) : null}
          <Heading id={titleId} className="xos-mkt-display-40">
            {title}
          </Heading>
          {lead ? <p className="xos-mkt-lead">{lead}</p> : null}
          {badge ?? null}
        </header>
        {children}
      </div>
    </section>
  );
}
