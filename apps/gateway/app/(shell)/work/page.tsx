import { redirect } from "next/navigation";
import { requireNode } from "@/lib/shell/sitemap";

/** Work (Section 4.5.8) opens on its first tab, Upcoming. */
export default async function WorkPage() {
  await requireNode("work");
  redirect("/work/upcoming");
}
