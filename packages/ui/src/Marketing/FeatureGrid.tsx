import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { Icon } from "../Icon/Icon.tsx";
import { DepartmentGlyph } from "../Glyphs/Glyphs.tsx";
import { codeClass } from "../Chips/codeClass.tsx";
import { cardClass } from "../Surface/Surface.tsx";
import { linkClass } from "../Link/link-class.ts";
import { marketingCopy } from "./marketing-copy.ts";
import { type FeatureGridProps } from "./Marketing.types.ts";

/**
 * Cards in a grid. An item with a department code draws that department's glyph and prints the
 * code beside the name. An external link opens a new tab and says so.
 */
export function FeatureGrid({
  columns = 3,
  headingLevel = 3,
  items,
  locale,
  messages,
}: FeatureGridProps): ReactElement {
  const { t } = marketingCopy({ locale, messages });
  const Heading = `h${headingLevel}` as const;
  return (
    <ul
      className={cx(
        "xos-mkt-grid",
        columns === 3 && "xos-mkt-grid-3",
        columns === 4 && "xos-mkt-grid-4",
        columns === 5 && "xos-mkt-grid-5",
      )}
    >
      {items.map((item) => (
        <li key={item.title} className={cx(cardClass, "xos-mkt-feature")}>
          <div className="xos-mkt-feature-head">
            {item.code ? (
              <span className="xos-mkt-tile" aria-hidden="true">
                <DepartmentGlyph code={item.code} size={16} />
              </span>
            ) : item.icon ? (
              <span className="xos-mkt-tile" aria-hidden="true">
                <Icon name={item.icon} size={16} />
              </span>
            ) : null}
            <Heading>{item.title}</Heading>
            {item.code ? <span className={codeClass}>{item.code}</span> : null}
          </div>
          {item.body ? <p>{item.body}</p> : null}
          {item.link ? (
            <a
              href={item.link.href}
              {...(item.link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
              className={cx(linkClass, "xos-mkt-feature-link")}
            >
              {item.link.label}
              {item.link.external ? (
                <Icon name="ExternalLink" size={12} label={t("link.newTab")} />
              ) : null}
            </a>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
