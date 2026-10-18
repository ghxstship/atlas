import { type ReactElement } from "react";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Button } from "../Button/Button.tsx";
import { type PaginationProps } from "./Navigation.types.ts";

/** Cursor paging: a summary and Previous and Next, never page numbers it cannot jump to. */
export function Pagination({
  summary,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
}: PaginationProps): ReactElement {
  const t = useT();
  return (
    <nav aria-label={t("nav.pagination")} className="flex flex-wrap items-center justify-end gap-8">
      <span className="text-text-secondary tabular-nums" aria-live="polite">
        {summary}
      </span>
      <Button size="sm" icon="ChevronLeft" disabled={!hasPrev} onClick={onPrev}>
        {t("nav.previous")}
      </Button>
      <Button size="sm" disabled={!hasNext} onClick={onNext}>
        {t("nav.next")}
        <Icon name="ChevronRight" size={14} />
      </Button>
    </nav>
  );
}
