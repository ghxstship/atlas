import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { ScrollRegion } from "../Layout/Layout.tsx";
import { type DiffViewerProps } from "./Editing.types.ts";

/** Field-level changes with color plus strike-through or underline, so change never relies on color. */
export function DiffViewer({ caption, rows }: DiffViewerProps): ReactElement {
  const t = useT();
  const th = cx(
    "h-control-lg px-12 text-start font-medium text-text-12 text-text-secondary bg-bg-surface border-b border-border-subtle",
  );
  const td = cx("h-row-default px-12 border-b border-border-subtle");
  return (
    <ScrollRegion label={caption ?? t("scroll.region")}>
      <table className="w-full border-collapse text-text-13">
        {caption ? <caption className="pb-8 text-start font-semibold">{caption}</caption> : null}
        <thead>
          <tr>
            <th scope="col" className={th}>
              {t("diff.field")}
            </th>
            <th scope="col" className={th}>
              {t("diff.before")}
            </th>
            <th scope="col" className={th}>
              {t("diff.after")}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.field}>
              <td className={cx(td, "text-text-secondary")}>{r.field}</td>
              <td className={td}>
                <del className="line-through text-danger-text">{r.before}</del>
              </td>
              <td className={td}>
                <ins className="underline underline-offset-(length:--space-2) text-success-text">
                  {r.after}
                </ins>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}
