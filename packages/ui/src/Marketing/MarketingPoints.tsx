import { type ReactElement } from "react";
import { Icon } from "../Icon/Icon.tsx";
import { type MarketingPointsProps } from "./Marketing.types.ts";

/**
 * A list of short claims, each led by an icon: a success check unless `icon` names another. The
 * persona, surface and plan cards draw their points with it.
 */
export function MarketingPoints({
  points,
  icon = "Check",
  iconColor,
}: MarketingPointsProps): ReactElement {
  return (
    <ul className="xos-mkt-points">
      {points.map((point) => (
        <li key={point}>
          <Icon name={icon} size={16} {...(iconColor === undefined ? {} : { color: iconColor })} />
          <span>{point}</span>
        </li>
      ))}
    </ul>
  );
}
