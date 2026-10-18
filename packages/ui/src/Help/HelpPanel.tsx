import { useState, type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Button, IconButton } from "../Button/Button.tsx";
import { Keys } from "../Kbd/Kbd.tsx";
import { linkClass } from "../Link/Link.tsx";
import { type HelpPanelProps } from "./Help.types.ts";

const searchFieldClass = cx(
  "flex items-center gap-8 h-row-default ps-12 pe-8 rounded-control border border-border-control bg-bg-surface",
  "focus-within:outline-solid focus-within:outline-stroke-focus focus-within:outline-focus-ring",
);

const searchInputClass = cx(
  "flex-1 min-w-0 border-0 bg-transparent outline-none text-text-primary placeholder:text-text-tertiary pointer-coarse:min-h-target-coarse",
);

/** Help for this page: search, articles, its shortcuts, the assistant, What's New and support. */
export function HelpPanel({
  articles,
  shortcuts,
  assistant = false,
  onSearch,
  onArticle,
  onAsk,
  onWhatsNew,
  onContact,
  onClose,
}: HelpPanelProps): ReactElement {
  const t = useT();
  const [question, setQuestion] = useState("");
  return (
    <aside
      aria-label={t("help.title")}
      className="flex flex-col w-(--layout-sidebar-max) max-w-full max-md:w-full rounded-card bg-bg-raised shadow-dialog"
    >
      <header className="flex items-center justify-between py-8 ps-20 pe-12 border-b border-border-subtle">
        <h2 className="m-0 text-text-13 font-semibold">{t("help.title")}</h2>
        <IconButton icon="X" label={t("action.close")} shortcut={t("key.esc")} onClick={onClose} />
      </header>
      <div className="flex flex-col gap-16 px-20 pt-16 pb-20">
        <label className={searchFieldClass}>
          <Icon name="Search" color="var(--color-text-secondary)" />
          <input
            type="search"
            aria-label={t("help.search")}
            placeholder={t("help.search")}
            onChange={(e) => onSearch?.(e.target.value)}
            className={searchInputClass}
          />
        </label>
        <section>
          <h3 className="m-0 mb-6 text-text-12 font-medium text-text-secondary">
            {t("help.forThisPage")}
          </h3>
          <ul className="flex flex-col gap-6 m-0 p-0 list-none">
            {articles.map((a) => (
              <li key={a}>
                <button
                  type="button"
                  onClick={() => onArticle?.(a)}
                  className={cx(linkClass, "p-0 border-0 bg-transparent cursor-pointer text-start")}
                >
                  {a}
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3 className="m-0 mb-6 text-text-12 font-medium text-text-secondary">
            {t("help.shortcuts")}
          </h3>
          {shortcuts.map((s) => (
            <div key={s.label} className="flex items-center justify-between min-h-control-md">
              <span>{s.label}</span>
              <Keys keys={s.keys} />
            </div>
          ))}
        </section>
        {assistant ? (
          <section>
            <h3 className="m-0 mb-6 text-text-12 font-medium text-text-secondary">
              {t("help.assistant")}
            </h3>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (question.trim()) onAsk?.(question.trim());
              }}
              className={searchFieldClass}
            >
              <Icon name="Sparkles" color="var(--color-text-secondary)" />
              <input
                aria-label={t("help.ask")}
                placeholder={t("help.ask")}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                className={searchInputClass}
              />
            </form>
          </section>
        ) : null}
        <div className="flex flex-wrap gap-8">
          <Button icon="Megaphone" onClick={onWhatsNew}>
            {t("help.whatsNew")}
          </Button>
          <Button icon="LifeBuoy" onClick={onContact}>
            {t("help.contact")}
          </Button>
        </div>
      </div>
    </aside>
  );
}
