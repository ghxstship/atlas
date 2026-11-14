import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { Icon } from "../Icon/Icon.tsx";
import { Tag } from "../Chips/Tag.tsx";
import { cardClass } from "../Surface/Surface.tsx";
import { linkClass } from "../Link/link-class.ts";
import { MarketingPoints } from "./MarketingPoints.tsx";
import { type SurfaceTriptychProps } from "./Marketing.types.ts";

/** The three surfaces side by side, each with its audience, its status and what it covers. */
export function SurfaceTriptych({ items }: SurfaceTriptychProps): ReactElement {
  return (
    <ul className="xos-mkt-grid xos-mkt-grid-3">
      {items.map((item) => (
        <li key={item.name} className={cx(cardClass, "xos-mkt-feature")}>
          <div className="xos-mkt-feature-head">
            {item.icon ? (
              <span className="xos-mkt-tile" aria-hidden="true">
                <Icon name={item.icon} size={16} />
              </span>
            ) : null}
            <h3>{item.name}</h3>
            {item.status ? (
              <span className="xos-mkt-feature-status">
                <Tag {...(item.status.tone === undefined ? {} : { tone: item.status.tone })}>
                  {item.status.label}
                </Tag>
              </span>
            ) : null}
          </div>
          {item.audience ? <p className="xos-mkt-feature-aud">{item.audience}</p> : null}
          <p>{item.body}</p>
          {item.points ? <MarketingPoints points={item.points} /> : null}
          {item.link ? (
            <a href={item.link.href} className={cx(linkClass, "xos-mkt-feature-link")}>
              {item.link.label}
            </a>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
