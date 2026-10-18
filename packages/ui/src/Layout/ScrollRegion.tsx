import { useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { type ScrollRegionProps } from "./Layout.types.ts";

/**
 * Keeps wide content inside the page width: it scrolls horizontally in a labeled region that joins
 * the tab order only while it overflows.
 */
export function ScrollRegion({
  label,
  children,
  className,
  style,
  ref: outer,
}: ScrollRegionProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const setRef = (el: HTMLDivElement | null) => {
    ref.current = el;
    if (typeof outer === "function") outer(el);
    else if (outer) outer.current = el;
  };
  // Server rendered markup cannot measure, so the region starts in the tab order and leaves it once
  // the first measure finds nothing to scroll. Starting out of it left wide content unreachable by
  // keyboard until hydration (A23-015).
  const [overflows, setOverflows] = useState(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => setOverflows(el.scrollWidth > el.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    // Content can grow wider after the first measure (rows load, fonts swap), so watch the region's
    // children as well as its own box, and re-observe when children change.
    const observer = new ResizeObserver(measure);
    const observeAll = () => {
      observer.disconnect();
      observer.observe(el);
      for (const child of Array.from(el.children)) observer.observe(child);
      measure();
    };
    observeAll();
    const mutations =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(observeAll);
    mutations?.observe(el, { childList: true });
    return () => {
      observer.disconnect();
      mutations?.disconnect();
    };
  }, []);
  return (
    <div
      ref={setRef}
      role="region"
      aria-label={label}
      tabIndex={overflows ? 0 : undefined}
      style={style}
      className={cx("relative max-w-full overflow-x-auto overscroll-x-contain", className)}
    >
      {children}
    </div>
  );
}
