import type { ReactElement } from "react";
import type {
  AvatarProps as ReferenceAvatarProps,
  AvatarStackProps as ReferenceAvatarStackProps,
} from "../types/reference";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";

export type AvatarProps = ReferenceAvatarProps;
export type AvatarStackProps = ReferenceAvatarStackProps;

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

export const avatarClass = cx(
  "inline-grid place-items-center flex-none rounded-full bg-bg-hover text-text-primary font-semibold",
  "ring-(length:--stroke-width-focus) ring-bg-canvas",
);

/** Initials in a circle, named for assistive technology. */
export function Avatar({ name, size = "md" }: AvatarProps): ReactElement {
  return (
    <span
      role="img"
      aria-label={name}
      title={name}
      className={cx(
        avatarClass,
        size === "lg" ? "size-(--ui-avatar-lg) text-text-12" : "size-(--ui-avatar) text-text-11",
      )}
    >
      {initials(name)}
    </span>
  );
}

/** Up to `max` avatars (3 by default) and a count of the rest. */
export function AvatarStack({ names, max = 3 }: AvatarStackProps): ReactElement {
  const t = useT();
  const shown = names.slice(0, max);
  const extra = names.length - shown.length;
  return (
    <span className="inline-flex [&>*+*]:ms-(--ui-avatar-overlap)">
      {shown.map((name) => (
        <Avatar key={name} name={name} />
      ))}
      {extra > 0 ? (
        <span
          role="img"
          aria-label={t("avatar.more", { n: extra })}
          className={cx(
            avatarClass,
            "size-(--ui-avatar) text-text-11 bg-bg-surface text-text-secondary tabular-nums",
          )}
        >
          +{extra}
        </span>
      ) : null}
    </span>
  );
}
