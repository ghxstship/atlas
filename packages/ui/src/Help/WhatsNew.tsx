import { type ReactElement } from "react";
import { useT } from "../lib/context.tsx";
import { Tag } from "../Chips/Chips.tsx";
import { cardBodyClass, cardClass, cardHeadClass } from "../Surface/Surface.tsx";
import { linkClass } from "../Link/Link.tsx";
import { type WhatsNewProps } from "./Help.types.ts";

/** Recent changes with a link to the full changelog. */
export function WhatsNew({ changelogHref, entries }: WhatsNewProps): ReactElement {
  const t = useT();
  return (
    <section aria-label={t("whatsNew.title")} className={cardClass}>
      <header className={cardHeadClass}>
        <h2 className="m-0 text-text-13 font-semibold">{t("whatsNew.title")}</h2>
        <a href={changelogHref} className={linkClass}>
          {t("whatsNew.changelog")}
        </a>
      </header>
      <div className={cardBodyClass}>
        {entries.map((e) => (
          <article key={e.title} className="flex flex-col gap-4">
            <div className="flex items-center gap-6">
              <Tag tone={e.tone ?? "accent"}>{e.label}</Tag>
              <span className="text-text-secondary">{e.date}</span>
            </div>
            <h3 className="m-0 text-text-13 font-semibold">{e.title}</h3>
            <p className="m-0 text-text-secondary">{e.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
