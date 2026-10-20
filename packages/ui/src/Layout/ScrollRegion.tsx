import { useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { type ScrollRegionProps } from "./Layout.types.ts";

interface Edges {
  /** Content is hidden past the logical start (scrolled away from it). */
  readonly start: boolean;
  /** Content is hidden past the logical end. */
  readonly end: boolean;
}

const NO_EDGES: Edges = { start: false, end: false };

const edgeClass = cx(
  "pointer-events-none absolute inset-y-0 z-sticky w-(--space-48) from-bg-canvas to-transparent",
  "print:hidden forced-colors:hidden",
);

/**
 * Keeps wide content inside the page width: it scrolls horizontally in a labeled region that joins
 * the tab order only while it overflows. While content is hidden past an edge, that edge fades, so a
 * table or board cut off at the right shows that it scrolls (A59-012).
 */
export function ScrollRegion({
  label,
  children,
  className,
  frameClassName,
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
  const [edges, setEdges] = useState<Edges>(NO_EDGES);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      const room = el.scrollWidth - el.clientWidth;
      setOverflows(room > 1);
      // scrollLeft runs negative from the start in right-to-left, so the distance is its magnitude.
      const at = Math.abs(el.scrollLeft);
      const start = room > 1 && at > 1;
      const end = room > 1 && at < room - 1;
      setEdges((old) => (old.start === start && old.end === end ? old : { start, end }));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    if (typeof ResizeObserver === "undefined") {
      return () => el.removeEventListener("scroll", measure);
    }
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
      el.removeEventListener("scroll", measure);
      observer.disconnect();
      mutations?.disconnect();
    };
  }, []);
  return (
    <div className={cx("relative min-w-0 max-w-full", frameClassName)}>
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
      {edges.start ? (
        <span
          aria-hidden="true"
          data-scroll-edge="start"
          className={cx(edgeClass, "start-0 bg-linear-to-r rtl:bg-linear-to-l")}
        />
      ) : null}
      {edges.end ? (
        <span
          aria-hidden="true"
          data-scroll-edge="end"
          className={cx(edgeClass, "end-0 bg-linear-to-l rtl:bg-linear-to-r")}
        />
      ) : null}
    </div>
  );
}
