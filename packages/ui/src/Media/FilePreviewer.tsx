import { useState, type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { IconButton } from "../Button/Button.tsx";
import { type FilePreviewerProps } from "./Media.types.ts";

/**
 * A file with page thumbnails, zoom and download; the page area holds the rendered page. A file of
 * one page (an image, a video) has no thumbnail rail.
 */
export function FilePreviewer({
  name,
  meta,
  pages,
  page = 0,
  zoom = "100%",
  icon,
  children,
  onPage,
  onZoomIn,
  onZoomOut,
  onDownload,
  zoomable = true,
  downloadable = true,
}: FilePreviewerProps): ReactElement {
  const t = useT();
  const [current, setCurrent] = useState(page);
  return (
    <section aria-label={name} className="overflow-hidden rounded-card border border-border-subtle">
      <div className="flex flex-wrap items-center gap-8 min-h-(--ui-shell-head) ps-12 pe-8 bg-bg-surface border-b border-border-subtle">
        <Icon name={icon ?? "FileText"} color="var(--color-text-secondary)" />
        <strong className="font-semibold">{name}</strong>
        <span className="text-text-secondary">{meta}</span>
        <span className="flex items-center gap-2 ms-auto">
          {zoomable ? (
            <>
              <IconButton icon="ZoomOut" label={t("file.zoomOut")} onClick={onZoomOut} />
              <span className="text-text-secondary tabular-nums" aria-live="polite">
                {zoom}
              </span>
              <IconButton icon="ZoomIn" label={t("file.zoomIn")} onClick={onZoomIn} />
            </>
          ) : null}
          {downloadable ? (
            <IconButton icon="Download" label={t("action.download")} onClick={onDownload} />
          ) : null}
        </span>
      </div>
      <div className="flex h-(--ui-listbox-max) max-sm:flex-col">
        {pages > 1 ? (
          <div className="flex flex-col max-sm:flex-row gap-8 w-(--space-64) max-sm:w-full p-8 overflow-auto bg-bg-surface border-e border-border-subtle">
            {Array.from({ length: pages }, (_, i) => (
              <button
                key={i}
                type="button"
                aria-label={t("file.page", { n: i + 1 })}
                aria-pressed={i === current}
                onClick={() => {
                  setCurrent(i);
                  onPage?.(i);
                }}
                className={cx(
                  "flex-none h-(--space-64) max-sm:w-(--space-48) rounded-chip border border-border-subtle bg-bg-raised text-text-11 text-text-tertiary cursor-pointer tabular-nums",
                  "aria-pressed:border-accent aria-pressed:text-text-primary",
                )}
              >
                {i + 1}
              </button>
            ))}
          </div>
        ) : null}
        {/* Safe centering keeps a zoomed page scrollable to its start edge. */}
        <div className="flex flex-1 justify-center-safe p-24 overflow-auto bg-bg-surface">
          {children}
        </div>
      </div>
    </section>
  );
}
