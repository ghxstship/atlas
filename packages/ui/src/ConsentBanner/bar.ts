import { cx } from "../lib/cx.ts";

/**
 * The cookie bar both banners draw (ConsentBanner and ConsentBannerStatic, decision 2026-11-27): a
 * bar at the bottom edge of the viewport, full width, with a border and the menu shadow on top.
 *
 * It comes first in the DOM, so keyboard and screen reader users reach it before the page, and is
 * drawn last: `data-xos-consent-bar` makes its parent a column (styles/base.css), and the bar takes
 * `order-last` and `mt-auto` there and sticks to the bottom edge. While the page scrolls it stays on
 * screen like a fixed bar; at the end of the page it sits in the flow after the footer, so it holds
 * its own height and never covers the last control, closed or with Choose open. No script measures
 * it.
 *
 * `z-header` puts it over the page, sticky rows and the sidebar, and under dropdowns, popovers,
 * side peeks, dialogs, the command menu, toasts and tooltips. The safe-area insets keep it clear
 * of a phone's home indicator and rounded corners, and its cap, `--ui-consent-bar-max` (60% of the
 * viewport), with its own scroll keeps the open Choose panel from covering the whole screen of a
 * short phone. The page's scroll padding is that cap too (styles/base.css), so keyboard focus never
 * lands on a control under the bar (WCAG 2.4.11).
 */
export const consentBarClass = cx(
  "sticky bottom-0 z-header order-last mt-auto max-h-(--ui-consent-bar-max)",
  "overflow-y-auto overscroll-contain",
  "border-t border-border-subtle bg-bg-surface shadow-menu",
  "pt-16 pb-[calc(var(--space-16)+env(safe-area-inset-bottom))]",
  "px-[max(var(--space-16),env(safe-area-inset-left),env(safe-area-inset-right))]",
  "font-sans text-text-primary print:hidden",
);
export const consentInnerClass = cx("mx-auto flex max-w-layout-reading flex-col gap-12");
export const consentTextClass = cx("m-0 text-text-13 text-text-secondary");
