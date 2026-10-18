import { type ReactElement } from "react";
import type { OrgChartNode } from "../types/reference";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { Avatar } from "../Avatar/Avatar.tsx";
import { ScrollRegion } from "../Layout/Layout.tsx";
import { type OrgChartProps } from "./Charts.types.ts";

function OrgNode({ node }: { node: OrgChartNode }) {
  const t = useT();
  const reports = node.reports ?? [];
  return (
    <li className="relative flex flex-col items-center">
      <div className="flex items-center gap-8 px-12 py-8 whitespace-nowrap rounded-card border border-border-subtle bg-bg-raised text-text-12">
        {node.name ? (
          <Avatar name={node.name} />
        ) : (
          <span
            aria-hidden="true"
            className="inline-grid place-items-center size-(--ui-avatar) rounded-full bg-bg-surface text-text-secondary"
          >
            <Icon name="UserPlus" size={12} />
          </span>
        )}
        <span className="flex flex-col">
          <strong className="font-semibold">{node.name ?? t("org.vacant")}</strong>
          <span className="text-text-secondary">{node.role}</span>
          {node.code ? <span className="font-mono text-text-secondary">{node.code}</span> : null}
        </span>
      </div>
      {reports.length ? (
        <ul className="relative flex justify-center gap-16 m-0 pt-20 p-0 list-none before:absolute before:top-0 before:start-1/2 before:h-(--space-12) before:border-s before:border-border-control">
          {reports.map((r) => (
            <OrgNode key={`${r.name ?? ""}-${r.role}`} node={r} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** Reporting lines as a nested list; vacant positions read Vacant rather than being hidden. */
export function OrgChart({ label, root }: OrgChartProps): ReactElement {
  return (
    <ScrollRegion label={label}>
      <div role="group" aria-label={label} className="w-max min-w-full">
        <ul className="flex justify-center m-0 p-0 list-none">
          <OrgNode node={root} />
        </ul>
      </div>
    </ScrollRegion>
  );
}
