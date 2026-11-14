"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { Icon } from "../Icon/Icon.tsx";
import { cardClass } from "../Surface/Surface.tsx";
import { ButtonLink } from "./ButtonLink.tsx";
import { MarketingPoints } from "./MarketingPoints.tsx";
import { type PersonaSwitcherProps } from "./Marketing.types.ts";

/**
 * Tabs by audience. Every panel is rendered, so each audience's copy is in the document; the hash
 * keeps the choice linkable (#for-finance). Arrow keys, Home and End move between tabs.
 */
export function PersonaSwitcher({
  label,
  personas,
  value,
  hash = true,
  hashPrefix = "for-",
  onChange,
}: PersonaSwitcherProps): ReactElement {
  const base = useId();
  const [current, setCurrent] = useState(value ?? personas[0]?.value ?? "");
  const tabs = useRef(new Map<string, HTMLButtonElement>());
  const values = personas.map((persona) => persona.value).join("\n");

  useEffect(() => {
    if (!hash) return undefined;
    const read = () => {
      const target = decodeURIComponent(window.location.hash.replace(/^#/, ""));
      const match = values.split("\n").find((v) => hashPrefix + v === target);
      if (match !== undefined) setCurrent(match);
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, [hash, hashPrefix, values]);

  const pick = (next: string, focus: boolean) => {
    setCurrent(next);
    if (hash) {
      try {
        window.history.replaceState(null, "", `#${hashPrefix}${next}`);
      } catch {
        // A sandboxed frame refuses history writes; the tab still changes.
      }
    }
    onChange?.(next);
    if (focus) tabs.current.get(next)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const count = personas.length;
    const rtl = event.currentTarget.closest("[dir]")?.getAttribute("dir") === "rtl";
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? count - 1
          : step !== 0
            ? (index + (rtl ? -step : step) + count) % count
            : -1;
    const persona = personas[next];
    if (persona === undefined) return;
    event.preventDefault();
    pick(persona.value, true);
  };

  return (
    <div className="xos-mkt-persona">
      <div className="xos-mkt-persona-tabs" role="tablist" aria-label={label}>
        {personas.map((persona, index) => {
          const on = current === persona.value;
          return (
            <button
              key={persona.value}
              type="button"
              role="tab"
              id={`${base}t${index}`}
              className="xos-mkt-persona-tab"
              aria-selected={on}
              aria-controls={`${base}p${index}`}
              tabIndex={on ? 0 : -1}
              ref={(el) => {
                if (el) tabs.current.set(persona.value, el);
                else tabs.current.delete(persona.value);
              }}
              onClick={() => pick(persona.value, false)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {persona.icon ? <Icon name={persona.icon} size={14} /> : null}
              {persona.label}
            </button>
          );
        })}
      </div>
      {personas.map((persona, index) => (
        <div
          key={persona.value}
          role="tabpanel"
          id={`${base}p${index}`}
          aria-labelledby={`${base}t${index}`}
          className="xos-mkt-persona-panel"
          hidden={current !== persona.value}
          tabIndex={0}
        >
          <div className="xos-mkt-persona-copy">
            <h3>{persona.title}</h3>
            <p>{persona.body}</p>
            {persona.primary || persona.secondary ? (
              <div className="xos-mkt-actions">
                {persona.primary ? (
                  <ButtonLink href={persona.primary.href} variant="primary" size="xl">
                    {persona.primary.label}
                  </ButtonLink>
                ) : null}
                {persona.secondary ? (
                  <ButtonLink href={persona.secondary.href} size="xl">
                    {persona.secondary.label}
                  </ButtonLink>
                ) : null}
              </div>
            ) : null}
          </div>
          {persona.points ? (
            <div className={cx(cardClass, "xos-mkt-persona-points")}>
              {persona.pointsTitle ? <p className="xos-mkt-label">{persona.pointsTitle}</p> : null}
              <MarketingPoints points={persona.points} />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
