import { loadCustomFieldForm } from "@/lib/custom-fields/server";
import type { CustomFieldTable } from "@/lib/custom-fields/types";
import { getOrgContext } from "@/lib/shell/context";
import { CustomFieldsSection } from "./custom-fields-section";

/**
 * A row's custom fields on a server-rendered record page or peek (A117): one line beside the row's other
 * sections, `<CustomFieldsPanel org={slug} table="app.vendors" id={vendor.id} />`. Loads the fields and values on
 * the server, so the section paints with the page, and renders nothing when the table has no custom fields.
 */
export async function CustomFieldsPanel({
  org,
  table,
  id,
  editable = true,
}: {
  org: string;
  table: CustomFieldTable;
  id: string;
  editable?: boolean;
}) {
  const ctx = await getOrgContext(org);
  if (!ctx) return null;
  const form = await loadCustomFieldForm(ctx, table, id);
  if (form.fields.length === 0) return null;
  return <CustomFieldsSection table={table} id={id} initial={form} editable={editable} />;
}
