import type { OrgContext } from "@/lib/shell/context";
import { CONTRIBUTIONS } from "./contributions/index.generated";

/** The panels modules contribute to a settings page, in order, for hand-written settings pages. */
export function ContributedPanels({
  node,
  ctx,
  params,
}: {
  node: string;
  ctx: OrgContext;
  params: Readonly<Record<string, string>>;
}) {
  const panels = CONTRIBUTIONS.filter((c) => c.node === node).sort((a, b) => a.order - b.order);
  return (
    <>
      {panels.map(({ Panel }, index) => (
        <Panel key={`${node}-${index}`} ctx={ctx} params={params} />
      ))}
    </>
  );
}
