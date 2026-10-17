import type { ReactElement } from "react";

export interface SparklineProps {
  values: (number | null)[];
  /** Decorative unless labeled; the tile states the figure in text. */
  label?: string;
}

const WIDTH = 96;
const HEIGHT = 24;

/** Maps `value` from [d0, d1] onto [r0, r1], as a linear scale does. */
function linear(value: number, d0: number, d1: number, r0: number, r1: number): number {
  return d1 === d0 ? (r0 + r1) / 2 : r0 + ((value - d0) / (d1 - d0)) * (r1 - r0);
}

/** The SVG path of a line through the values; a null value ends one run and starts the next. */
export function sparklinePath(values: readonly (number | null)[]): string {
  const numbers = values.filter((v): v is number => v !== null);
  const min = Math.min(...numbers, 0);
  const max = Math.max(...numbers, 1);
  const last = Math.max(1, values.length - 1);
  let path = "";
  let drawing = false;
  values.forEach((v, i) => {
    if (v === null) {
      drawing = false;
      return;
    }
    const x = linear(i, 0, last, 1, WIDTH - 1);
    const y = linear(v, min, max, HEIGHT - 2, 2);
    path += `${drawing ? "L" : "M"}${x},${y}`;
    drawing = true;
  });
  return path;
}

/**
 * A small trend line for StatTile; decorative unless labeled. Gaps stay gaps. It draws its own
 * path so that the list and board views that show it never load the chart library (A24-009).
 */
export function Sparkline({ values, label }: SparklineProps): ReactElement {
  return (
    <svg
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      <path
        d={sparklinePath(values)}
        className="fill-none stroke-accent"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
