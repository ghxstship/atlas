import { listDayTemplateItems, listDayTemplates } from "@xos/data/day-templates";
import type { OrgContext } from "@/lib/shell/context";
import { DayTemplatesPanel } from "./day-templates-panel";

/**
 * Projects > Templates, Day templates (B4, G-42): the org's day templates beside its project templates, in tables of
 * their own because v1 freezes the template kinds. Pick one to see and edit its items; remove one to Trash. A day is
 * saved as a template from Schedule, Days. Row level security decides what appears; projects.template.write edits.
 */
export async function DayTemplatesSection({
  ctx,
  selected,
}: {
  ctx: OrgContext;
  selected: string | null;
}) {
  const db = ctx.viewer.db;
  const templates = await listDayTemplates(db, ctx.org.id);
  const current = templates.ok ? (templates.data.find((x) => x.id === selected) ?? null) : null;
  const items = current ? await listDayTemplateItems(db, current.id) : null;
  return (
    <DayTemplatesPanel
      org={ctx.org.slug}
      templates={templates.ok ? templates.data : []}
      loadFailed={!templates.ok}
      current={current}
      items={items?.ok ? items.data : []}
      canEdit={ctx.capabilities.has("projects.template.write")}
    />
  );
}
