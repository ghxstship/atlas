"use client";

import { useState, type ReactElement } from "react";
import { useT } from "../lib/context.tsx";
import { applyTheme, isThemePreference } from "../lib/theme.ts";
import { Select } from "../Forms/Select.tsx";
import { SegmentedControl } from "../Navigation/SegmentedControl.tsx";
import { type MarketingFooterProps } from "./Marketing.types.ts";

/**
 * The footer of a public page: brand, link columns, the legal line, and the language and theme
 * controls. Without `onTheme` the theme control applies the choice to the document root.
 */
export function MarketingFooter({
  brand,
  tagline,
  label,
  columns,
  legal,
  locales,
  locale,
  onLocale,
  themes = true,
  theme = "dark",
  onTheme,
}: MarketingFooterProps): ReactElement {
  const t = useT();
  const [current, setCurrent] = useState<string>(theme);
  const setTheme = (next: string) => {
    setCurrent(next);
    if (onTheme) onTheme(next);
    else if (isThemePreference(next)) applyTheme(next);
  };
  return (
    <footer className="xos-mkt-footer">
      <div className="xos-mkt-wrap">
        <div className="xos-mkt-footer-top">
          <div className="xos-mkt-footer-brand">
            {brand}
            {tagline ? <p>{tagline}</p> : null}
          </div>
          <nav className="xos-mkt-footer-cols" aria-label={label}>
            {columns.map((column) => (
              <div key={column.title}>
                <h2>{column.title}</h2>
                <ul>
                  {column.links.map((link) => (
                    <li key={link.label}>
                      <a href={link.href}>{link.label}</a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>
        <div className="xos-mkt-footer-base">
          <p>{legal}</p>
          <div className="xos-mkt-footer-controls">
            {locales ? (
              <Select
                label={t("mk.footer.language")}
                options={locales}
                {...(locale === undefined ? {} : { value: locale })}
                {...(onLocale === undefined ? {} : { onChange: onLocale })}
              />
            ) : null}
            {themes ? (
              <div className="xos-mkt-footer-theme">
                <span className="xos-mkt-label">{t("mk.footer.theme")}</span>
                <SegmentedControl
                  label={t("mk.footer.theme")}
                  value={current}
                  onChange={setTheme}
                  options={[
                    { value: "dark", label: t("mk.theme.dark") },
                    { value: "light", label: t("mk.theme.light") },
                    { value: "sunlight", label: t("mk.theme.sunlight") },
                  ]}
                />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </footer>
  );
}
