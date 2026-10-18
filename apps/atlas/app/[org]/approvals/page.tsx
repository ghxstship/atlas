import { requireNode } from "@/lib/shell/require-node";
import { ApprovalsView } from "@/components/workflow/approvals-view";

/** Approvals (A33): spend documents going through the org's approval policies. */
export default async function Page({ params, searchParams }: PageProps<"/[org]/approvals">) {
  const ctx = await requireNode("approvals", await params);
  const tab = (await searchParams)["tab"];
  return <ApprovalsView ctx={ctx} tab={typeof tab === "string" ? tab : null} />;
}
