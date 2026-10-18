import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Badge } from "../Chips/Chips.tsx";
import { ItemAction } from "./Navigation.shared.tsx";
import { type TabBarProps } from "./Navigation.types.ts";

/** The five-destination bottom bar for phones; targets meet touch-min (48 pt). */
export function TabBar({
  label,
  items,
  active,
  compass = false,
  centerLabel,
}: TabBarProps): ReactElement {
  const t = useT();
  return (
    <nav
      aria-label={label}
      className={cx(
        "flex justify-around items-stretch w-(--ui-tabbar) max-w-full pt-6 pb-20 box-border bg-bg-surface border-t border-border-subtle",
        compass && "xos-compass",
      )}
    >
      {items.map((item) => {
        const center = item.label === centerLabel;
        return (
          <ItemAction
            key={item.label}
            item={item}
            active={item.label === active}
            className={cx(
              "flex flex-1 flex-col items-center justify-center gap-2 min-h-touch-min rounded-control no-underline",
              "text-text-11 font-medium text-text-secondary aria-[current=page]:text-accent-text",
            )}
          >
            <span
              className={cx(
                "relative inline-flex",
                center &&
                  "p-8 -mt-20 rounded-full bg-accent text-accent-text-on ring-(length:--space-4) ring-bg-surface",
              )}
            >
              <Icon name={item.icon} size={compass ? 24 : 20} />
              {item.badge ? (
                <Badge
                  count={item.badge}
                  tone="danger"
                  label={t("tabbar.badge", { n: item.badge })}
                  className="absolute -top-6 -end-12"
                />
              ) : null}
            </span>
            <span>{item.label}</span>
          </ItemAction>
        );
      })}
    </nav>
  );
}
