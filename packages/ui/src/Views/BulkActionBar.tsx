import { type ReactElement } from "react";
import { Toolbar as RToolbar } from "radix-ui";
import { cx } from "../lib/cx.ts";
import { useFormat, useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { buttonClass, iconButtonClass } from "../Button/Button.tsx";
import { Keys } from "../Kbd/Kbd.tsx";
import { type BulkActionBarProps } from "./Views.types.ts";

/**
 * Appears with a selection: the count and at most five actions every selected item allows. A
 * toolbar: arrow keys move between actions, Esc clears the selection.
 */
export function BulkActionBar({
  count,
  actions,
  onClear,
  onMore,
}: BulkActionBarProps): ReactElement {
  const t = useT();
  const fmt = useFormat();
  return (
    <RToolbar.Root
      aria-label={t("bulk.label")}
      onKeyDown={(e) => {
        if (e.key === "Escape" && onClear) {
          e.preventDefault();
          onClear();
        }
      }}
      className={cx(
        "xos-anim-fade inline-flex flex-wrap items-center gap-4 max-w-full py-4 ps-12 pe-4",
        "rounded-card bg-bg-raised shadow-menu print:hidden forced-colors:border",
      )}
    >
      <span className="tabular-nums" aria-live="polite">
        {t("bulk.selected", { n: fmt.number(count) })}
      </span>
      <RToolbar.Separator className="w-(--stroke-width-hairline) h-(--space-16) mx-4 bg-border-strong" />
      {actions.slice(0, 5).map((action) => (
        <RToolbar.Button
          key={action.label}
          className={buttonClass("ghost", "sm")}
          onClick={action.onSelect}
        >
          {action.icon ? <Icon name={action.icon} size={14} /> : null}
          {action.label}
          {action.shortcut ? (
            <span className="ms-4 inline-flex">
              <Keys keys={action.shortcut} />
            </span>
          ) : null}
        </RToolbar.Button>
      ))}
      <RToolbar.Button
        className={iconButtonClass()}
        aria-label={t("menu.more")}
        title={t("menu.more")}
        onClick={onMore}
      >
        <Icon name="Ellipsis" />
      </RToolbar.Button>
      <RToolbar.Button
        className={iconButtonClass()}
        aria-label={t("bulk.clear")}
        title={t("tooltip.withShortcut", { label: t("bulk.clear"), shortcut: t("key.esc") })}
        onClick={onClear}
      >
        <Icon name="X" />
      </RToolbar.Button>
    </RToolbar.Root>
  );
}
