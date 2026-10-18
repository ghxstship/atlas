import { type ReactElement } from "react";
import { useFormat, useT } from "../lib/context.tsx";
import { Avatar } from "../Avatar/Avatar.tsx";
import { type PresenceIndicatorProps } from "./Identity.types.ts";

/** Who is viewing or editing a record live; the count and names are announced together. */
export function PresenceIndicator({
  names,
  verb = "viewing",
}: PresenceIndicatorProps): ReactElement {
  const t = useT();
  const fmt = useFormat();
  const summary = t(verb === "editing" ? "presence.editing" : "presence.viewing", {
    n: names.length,
  });
  return (
    <span
      role="img"
      aria-label={t(verb === "editing" ? "presence.namesEditing" : "presence.namesViewing", {
        names: fmt.list(names),
      })}
      className="inline-flex items-center gap-8 text-text-12"
    >
      <span aria-hidden="true" className="inline-flex [&>*+*]:ms-(--ui-avatar-overlap)">
        {names.slice(0, 3).map((name) => (
          <span key={name} className="relative inline-flex">
            <Avatar name={name} />
            <span className="absolute -end-(--stroke-width-hairline) -bottom-(--stroke-width-hairline) size-(--space-8) rounded-full bg-success ring-(length:--stroke-width-focus) ring-bg-canvas" />
          </span>
        ))}
      </span>
      <span aria-hidden="true" className="text-text-secondary">
        {summary}
      </span>
    </span>
  );
}
