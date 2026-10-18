import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { Icon } from "../Icon/Icon.tsx";
import { Avatar } from "../Avatar/Avatar.tsx";
import { chipClass } from "../Chips/Chips.tsx";
import { type ActivityFeedItemProps } from "./Views.types.ts";

/** One event or comment in a feed; reactions are glyph buttons with their counts. */
export function ActivityFeedItem({
  actor,
  action,
  target,
  time,
  comment,
  reactions,
  onReact,
}: ActivityFeedItemProps): ReactElement {
  return (
    <article className="flex items-start gap-12 max-w-(--layout-peek)">
      <Avatar name={actor} />
      <div className="flex flex-1 flex-col gap-4 min-w-0">
        <p className="m-0">
          <strong className="font-semibold">{actor}</strong>{" "}
          <span className="text-text-secondary">{action}</span>{" "}
          {target ? <span className="font-mono text-text-12">{target}</span> : null}{" "}
          <time className="text-text-secondary">{time}</time>
        </p>
        {comment ? (
          <div className="px-12 py-8 rounded-card border border-border-subtle bg-bg-surface">
            {comment}
          </div>
        ) : null}
        {reactions ? (
          <div className="flex flex-wrap gap-4">
            {reactions.map((r) => (
              <button
                key={r.label}
                type="button"
                aria-label={`${r.label} ${r.count}`}
                onClick={() => onReact?.(r.label)}
                className={cx(chipClass, "xos-hit cursor-pointer hover:bg-bg-hover")}
              >
                <Icon name={r.icon} size={12} />
                <span className="tabular-nums">{r.count}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}
