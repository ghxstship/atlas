import { UnitsView } from "@/components/assets/units-view";
import { requireNode } from "@/lib/shell/require-node";
import { readQuery } from "@/lib/assets/views";

/**
 * Assets > Units (Section 4.5.5): serialized gear at unit grain with the ten-value lifecycle and
 * the current custodian. `?peek=<asset tag>` opens the record beside the list; `&full=1` opens it
 * as a full page.
 */
export default async function UnitsPage({
  params,
  searchParams,
}: PageProps<"/[org]/assets/units">) {
  const ctx = await requireNode("assets.units", await params);
  return (
    <UnitsView
      ctx={ctx}
      node="assets.units"
      query={readQuery(await searchParams)}
      basePath={`/${ctx.org.slug}/assets/units`}
    />
  );
}
