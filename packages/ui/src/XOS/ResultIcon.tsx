import type { ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { Icon } from "../Icon/Icon.tsx";
import { type Result } from "./XOS.types.ts";

export const RESULT: Record<Result, { icon: string; className: string; key: string }> = {
  met: { icon: "CircleCheck", className: cx("text-success"), key: "result.met" },
  gap: { icon: "CircleX", className: cx("text-danger"), key: "result.gap" },
  unknown: { icon: "CircleHelp", className: cx("text-warning"), key: "result.unknown" },
};

/**
 * The met, gap or unknown mark of a criterion or a reconciliation row. It takes `t` as a prop and
 * reads no context, so a server component can draw it (ADR 0027).
 */
export function ResultIcon({
  result,
  t,
  labeled = true,
}: {
  result: Result;
  t: (key: string) => string;
  labeled?: boolean;
}): ReactElement {
  const r = RESULT[result];
  return (
    <span className={r.className}>
      <Icon name={r.icon} size={14} {...(labeled ? { label: t(r.key) } : {})} />
    </span>
  );
}
