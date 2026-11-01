import { projectFactRows } from "@xos/data/roster-facts-display";
import type { ProjectFactKind, RosterProjectFacts } from "@xos/data/roster-facts";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * What a roster entry holds for one project fact kind (R5), as a short list of labeled values. The wizard's Review and
 * read-only steps and the company's crew drawer share it; it renders only values the caller was already given.
 */

export function FactSummary({
  t,
  kind,
  facts,
}: {
  t: Translate;
  kind: ProjectFactKind;
  facts: Pick<RosterProjectFacts, "travel" | "uniform" | "vehicle">;
}) {
  const rows = projectFactRows(t, kind, facts);
  if (rows.length === 0) {
    return <p className="m-0 text-text-13 text-text-secondary">{t("projectFacts.notEntered")}</p>;
  }
  return (
    <dl className="m-0 grid grid-cols-[minmax(0,12rem)_1fr] gap-x-12 gap-y-4 text-text-14">
      {rows.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-text-secondary">{term}</dt>
          <dd className="m-0">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
