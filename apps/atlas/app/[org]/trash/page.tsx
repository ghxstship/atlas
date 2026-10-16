import { requireNode } from "@/components/shell/sitemap-page";
import { TrashView } from "@/components/workflow/trash-view";

/** Trash (A33): deleted rows the viewer may read, restorable for their retention period. */
export default async function Page({ params, searchParams }: PageProps<"/[org]/trash">) {
  const ctx = await requireNode("trash", await params);
  const search = await searchParams;
  const table =
    typeof search["table"] === "string" && /^[a-z][a-z0-9_]*$/.test(search["table"])
      ? search["table"]
      : null;
  const q =
    typeof search["q"] === "string" && search["q"].trim() !== ""
      ? search["q"].trim().slice(0, 100)
      : null;
  return <TrashView ctx={ctx} table={table} q={q} />;
}
