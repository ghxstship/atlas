"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import type { Chart as ChartComponent } from "@xos/ui";

const Chart = dynamic(() => import("./ui-chart").then((m) => m.Chart));

/** The space a chart takes before it loads: its 260 px plot, its title, subtitle and legend. */
const RESERVED_HEIGHT = 340;

/**
 * A chart below the fold, loaded as it nears the viewport: the visx code (about 21 KB) stays out of the page's first
 * load and its route budget (gate 10). The space is held while it loads, so nothing moves. Without
 * IntersectionObserver it loads at once.
 */
export function ChartWhenVisible(props: ComponentProps<typeof ChartComponent>) {
  const holder = useRef<HTMLDivElement | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const node = holder.current;
    if (near || node === null) return;
    if (typeof IntersectionObserver === "undefined") {
      const frame = requestAnimationFrame(() => setNear(true));
      return () => cancelAnimationFrame(frame);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "25% 0%" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [near]);
  return near ? (
    <Chart {...props} />
  ) : (
    <div ref={holder} style={{ minHeight: RESERVED_HEIGHT }} aria-hidden="true" />
  );
}
