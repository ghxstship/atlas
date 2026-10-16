import { requireNode } from "@/components/shell/sitemap-page";
import { TemplatesView } from "@/components/workflow/templates-view";

/** Projects > Templates (A33): project templates, their versions and creating projects from them. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/projects/templates">) {
  const ctx = await requireNode("projects.templates", await params);
  const template = (await searchParams)["template"];
  const selected =
    typeof template === "string" && /^[0-9a-f-]{36}$/.test(template) ? template : null;
  return <TemplatesView ctx={ctx} selected={selected} />;
}
