import { type ReactElement } from "react";
import { Icon } from "../Icon/Icon.tsx";

/** A checked list of short claims, shared by the persona, surface and plan cards. */
export function MarketingPoints({ points }: { points: string[] }): ReactElement {
  return (
    <ul className="xos-mkt-points">
      {points.map((point) => (
        <li key={point}>
          <Icon name="Check" size={16} />
          <span>{point}</span>
        </li>
      ))}
    </ul>
  );
}
