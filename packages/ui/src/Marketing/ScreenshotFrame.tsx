import { type ReactElement } from "react";
import { type ScreenshotFrameProps } from "./Marketing.types.ts";

/**
 * A product image in a window frame, or live XOS components standing in for one. Live content is
 * inert and exposed as one image named by `alt`, so it adds no tab stops and reads as a picture.
 */
export function ScreenshotFrame({
  src,
  alt,
  width,
  height,
  ratio = "16 / 10",
  title,
  chrome = true,
  eager = false,
  caption,
  children,
}: ScreenshotFrameProps): ReactElement {
  return (
    <figure className="xos-mkt-shot">
      {chrome ? (
        <div className="xos-mkt-shot-bar" aria-hidden="true">
          <i />
          <i />
          <i />
          {title ? <span>{title}</span> : null}
        </div>
      ) : null}
      {src ? (
        <div className="xos-mkt-shot-view" style={{ aspectRatio: ratio }}>
          <img
            src={src}
            alt={alt}
            width={width}
            height={height}
            loading={eager ? "eager" : "lazy"}
            decoding="async"
          />
        </div>
      ) : (
        <div
          className="xos-mkt-shot-view xos-mkt-shot-live"
          role="img"
          aria-label={alt}
          style={height === undefined ? undefined : { blockSize: height }}
        >
          <div inert aria-hidden="true">
            {children}
          </div>
        </div>
      )}
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}
