import { redirect } from "next/navigation";
import { requireNode } from "@/lib/shell/sitemap";

/** Money (Section 4.5.8) opens on Overview. */
export default async function MoneyPage() {
  await requireNode("money");
  redirect("/money/overview");
}
