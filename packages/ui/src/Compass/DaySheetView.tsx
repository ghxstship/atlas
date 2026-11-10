import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { IconButton } from "../Button/Button.tsx";
import { Tag } from "../Chips/Chips.tsx";
import { Avatar } from "../Avatar/Avatar.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { TL_CATEGORY } from "../Charts/categories.ts";
import { Phone } from "./Compass.shared.tsx";
import { type DaySheetViewProps } from "./Compass.types.ts";

/**
 * The day sheet: schedule with the current entry marked, and contacts with call and message. `dayTypes` names what
 * the day is (B4), as text with an icon and a categorical swatch.
 */
export function DaySheetView({
  frame,
  date,
  title,
  venue,
  entries,
  contacts,
  dayTypes = [],
  onCall,
  onMessage,
}: DaySheetViewProps): ReactElement {
  const t = useT();
  return (
    <Phone frame={frame}>
      <div className="flex flex-col gap-16 p-16">
        <header className="flex flex-col gap-2">
          <span className="text-text-secondary">{date}</span>
          <strong className="text-heading-20 font-semibold">{title}</strong>
          <span className="text-text-secondary">{venue}</span>
          {dayTypes.length > 0 ? (
            <ul
              className="m-0 flex list-none flex-wrap gap-4 p-0"
              aria-label={t("daysheet.dayTypes")}
            >
              {dayTypes.map((d) => (
                <li
                  key={d.label}
                  className="inline-flex items-center gap-4 rounded-chip bg-bg-surface px-6 text-text-12"
                >
                  <span
                    aria-hidden="true"
                    className={cx(
                      "inline-block size-(--space-8) rounded-mark",
                      TL_CATEGORY[d.category],
                    )}
                  />
                  {d.icon ? <Icon name={d.icon} size={12} /> : null}
                  {d.label}
                </li>
              ))}
            </ul>
          ) : null}
        </header>
        <ol className="m-0 p-0 list-none">
          {entries.map((e, i) => (
            <li
              key={i}
              aria-current={e.now ? "time" : undefined}
              className={cx(
                "grid grid-cols-[var(--ui-daysheet-time)_1fr_auto] items-center min-h-touch-min border-b border-border-subtle",
                e.now && "font-semibold",
              )}
            >
              <span className="text-text-secondary tabular-nums">{e.time}</span>
              <span>{e.label}</span>
              {e.now ? <Tag tone="accent">{t("daysheet.now")}</Tag> : null}
            </li>
          ))}
        </ol>
        <section className="flex flex-col">
          <h4 className="m-0 text-text-12 font-medium text-text-secondary">
            {t("daysheet.contacts")}
          </h4>
          {contacts.map((c) => (
            <div key={c.name} className="flex items-center gap-8 py-6">
              <Avatar name={c.name} />
              <div className="flex flex-col flex-1">
                <strong>{c.name}</strong>
                <span className="text-text-secondary">{c.role}</span>
              </div>
              <IconButton
                icon="Phone"
                variant="secondary"
                label={t("contact.call", { name: c.name })}
                onClick={() => onCall?.(c.name)}
              />
              <IconButton
                icon="MessageSquare"
                variant="secondary"
                label={t("contact.message", { name: c.name })}
                onClick={() => onMessage?.(c.name)}
              />
            </div>
          ))}
        </section>
      </div>
    </Phone>
  );
}
