import { requireNode } from "@/lib/shell/require-node";
import { TemplatesView } from "@/components/workflow/templates-view";

/** Projects > Templates (A33): project templates, their versions and creating projects from them. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/projects/templates">) {
  const ctx = await requireNode("projects.templates", await params);
  const search = await searchParams;
  const template = search["template"];
  const selected =
    typeof template === "string" && /^[0-9a-f-]{36}$/.test(template) ? template : null;
  const day = search["dayTemplate"];
  const dayTemplate = typeof day === "string" && /^[0-9a-f-]{36}$/.test(day) ? day : null;
  return <TemplatesView ctx={ctx} selected={selected} dayTemplate={dayTemplate} />;
}
