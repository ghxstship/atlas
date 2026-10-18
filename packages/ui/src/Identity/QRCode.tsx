import { useMemo, type ReactElement } from "react";
import { type QRCodeProps } from "./Identity.types.ts";
import { qrPath } from "./qrPath.tsx";

/** A scannable code as SVG, always dark on a light quiet zone so scanners read it in every theme. */
export function QRCode({ value, label, size = 160 }: QRCodeProps): ReactElement {
  const { size: modules, path } = useMemo(() => qrPath(value), [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${modules} ${modules}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className="block rounded-control"
    >
      <rect width={modules} height={modules} className="fill-paper" />
      <path d={path} className="fill-paper-ink" />
    </svg>
  );
}
