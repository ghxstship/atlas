import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Button } from "../Button/Button.tsx";
import { Keys } from "../Kbd/Kbd.tsx";
import { ScrollRegion } from "../Layout/Layout.tsx";
import { type ShortcutEditorProps } from "./Help.types.ts";

/** Every action's shortcut with conflicts named in place; Change records new keys, Reset restores a custom one. */
export function ShortcutEditor({
  label,
  rows,
  onChange,
  onReset,
}: ShortcutEditorProps): ReactElement {
  const t = useT();
  const th = cx(
    "h-control-lg px-12 text-start font-medium text-text-12 text-text-secondary bg-bg-surface border-b border-border-subtle",
  );
  const td = cx("h-row-default px-12 border-b border-border-subtle");
  return (
    <ScrollRegion label={label ?? t("shortcuts.title")}>
      <table className="w-full border-collapse text-text-13">
        <thead>
          <tr>
            <th scope="col" className={th}>
              {t("shortcutEditor.action")}
            </th>
            <th scope="col" className={th}>
              {t("shortcutEditor.shortcut")}
            </th>
            <th scope="col" className={th}>
              <span className="sr-only">{t("shortcutEditor.edit")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.action}>
              <td className={td}>{r.action}</td>
              <td className={td}>
                <span className="inline-flex flex-wrap items-center gap-8">
                  <Keys keys={r.keys} />
                  {r.conflict ? (
                    <span className="inline-flex items-center gap-4 text-text-12 text-danger-text">
                      <Icon name="alert" size={12} />
                      {r.conflict}
                    </span>
                  ) : null}
                </span>
              </td>
              <td className={cx(td, "text-end whitespace-nowrap")}>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-pressed={r.recording ?? false}
                  onClick={() => onChange?.(r.action)}
                >
                  {r.recording ? t("shortcutEditor.press") : t("shortcutEditor.change")}
                </Button>
                {r.custom ? (
                  <Button size="sm" variant="ghost" onClick={() => onReset?.(r.action)}>
                    {t("action.reset")}
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}
