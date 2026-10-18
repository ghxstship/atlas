import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { Icon } from "../Icon/Icon.tsx";
import { Avatar } from "../Avatar/Avatar.tsx";
import { chipClass } from "../Chips/Chips.tsx";
import { linkClass } from "../Link/Link.tsx";
import { type EPKViewerProps } from "./Gateway.types.ts";

const TILE_SEQ = [cx("bg-viz-seq-9"), cx("bg-viz-seq-8"), cx("bg-viz-seq-7"), cx("bg-viz-seq-6")];

/** An artist's press kit: media grid, bio, verified badges and links. */
export function EPKViewer({
  artist,
  headline,
  badges,
  bio,
  media,
  links,
  onMedia,
}: EPKViewerProps): ReactElement {
  return (
    <section aria-label={artist} className="flex flex-col gap-16 max-w-(--layout-form)">
      <header className="flex flex-wrap items-center gap-8">
        <Avatar name={artist} size="lg" />
        <div className="flex flex-col">
          <h2 className="m-0 text-heading-20 font-semibold">{artist}</h2>
          <span className="text-text-secondary">{headline}</span>
        </div>
        <span className="ms-auto flex flex-wrap gap-4">
          {badges.map((b) => (
            <span key={b} className={chipClass}>
              <span className="text-success">
                <Icon name="BadgeCheck" size={12} />
              </span>
              {b}
            </span>
          ))}
        </span>
      </header>
      <div className="grid grid-cols-4 max-sm:grid-cols-2 gap-8">
        {media.map((m, i) => (
          <button
            key={`${m.label}-${i}`}
            type="button"
            onClick={() => onMedia?.(m.label)}
            className={cx(
              "flex aspect-square flex-col items-center justify-center gap-6 rounded-card border-0 cursor-pointer",
              "text-accent-text-on font-medium text-text-12",
              TILE_SEQ[i % 4],
            )}
          >
            <Icon
              name={m.type === "video" ? "Play" : m.type === "audio" ? "AudioLines" : "Image"}
              size={20}
            />
            <span>{m.label}</span>
          </button>
        ))}
      </div>
      <p className="m-0 text-text-secondary">{bio}</p>
      <div className="flex flex-wrap gap-8">
        {links.map((l) => (
          <a
            key={l.label}
            href={l.href}
            className={linkClass}
            target="_blank"
            rel="noopener noreferrer"
          >
            {l.label}
            <Icon name="ExternalLink" size={12} />
          </a>
        ))}
      </div>
    </section>
  );
}
