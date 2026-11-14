"use client";

import { useId, useState, type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { iconButtonClass } from "../Button/button-class.ts";
import { Icon } from "../Icon/Icon.tsx";
import { type MarketingNavProps } from "./Marketing.types.ts";

function NavLinks({ links }: { links: MarketingNavProps["links"] }): ReactElement {
  return (
    <ul>
      {links.map((link) => (
        <li key={link.label}>
          <a href={link.href} aria-current={link.current ? "page" : undefined}>
            {link.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * The sticky header of a public page: skip link, brand, section links and the primary call to
 * action. From bp-lg the links sit in the bar; below it they move into a panel opened by a labeled
 * toggle. `actions` stays visible at every width.
 */
export function MarketingNav({
  brand,
  homeHref = "/",
  label,
  links,
  actions,
  secondaryActions,
  skipHref = "#main",
}: MarketingNavProps): ReactElement {
  const t = useT();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <header className="xos-mkt-nav">
      <a className="xos-mkt-skip" href={skipHref}>
        {t("mk.skip")}
      </a>
      <div className="xos-mkt-wrap xos-mkt-nav-bar">
        <a className="xos-mkt-nav-brand" href={homeHref}>
          {brand}
        </a>
        <nav className="xos-mkt-nav-links" aria-label={label ?? t("nav.main")}>
          <NavLinks links={links} />
        </nav>
        <div className="xos-mkt-nav-actions">
          {secondaryActions ? (
            <div className="xos-mkt-nav-secondary">{secondaryActions}</div>
          ) : null}
          {actions}
          <button
            type="button"
            className={cx(iconButtonClass("ghost"), "xos-mkt-nav-toggle")}
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={t(open ? "mk.nav.close" : "mk.nav.menu")}
            onClick={() => setOpen(!open)}
          >
            <Icon name={open ? "X" : "Menu"} />
          </button>
        </div>
      </div>
      <nav id={panelId} className="xos-mkt-nav-panel" hidden={!open} aria-label={t("mk.nav.menu")}>
        <NavLinks links={links} />
        {secondaryActions ? <div className="xos-mkt-actions">{secondaryActions}</div> : null}
      </nav>
    </header>
  );
}
