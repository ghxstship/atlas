import { Children, isValidElement, type CSSProperties, type ReactElement } from "react";
import { type GalleryProps } from "./Charts.types.ts";

/** Cards on an auto-filling grid; `min` sets the smallest card width in pixels (240 by default). */
export function Gallery({ label, min, children }: GalleryProps): ReactElement {
  const items = Children.toArray(children).filter((c) => !(typeof c === "string" && !c.trim()));
  const style = {
    "--xos-gallery-min":
      min === undefined ? "calc(var(--space-40) * 6)" : `calc(var(--space-4) * ${min / 4})`,
  } as CSSProperties;
  return (
    <div
      role="list"
      aria-label={label}
      style={style}
      className="grid grid-cols-[repeat(auto-fill,minmax(min(var(--xos-gallery-min),100%),1fr))] gap-16"
    >
      {items.map((child, i) => (
        <div role="listitem" key={isValidElement(child) && child.key !== null ? child.key : i}>
          {child}
        </div>
      ))}
    </div>
  );
}
