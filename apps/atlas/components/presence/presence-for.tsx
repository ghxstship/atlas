import { getViewer } from "@/lib/shell/context";
import { getTranslate } from "@/lib/shell/translate";
import type { PresenceTable } from "./presence";
import { RecordPresence } from "./record-presence";

/**
 * Presence for a record page, peek or document rendered on the server (Section 11.7, ADR 0083): the
 * signed-in person joins the row's channel under their name and sees who else is there.
 */
export async function PresenceFor({ table, id }: { table: PresenceTable; id: string }) {
  const person = (await getViewer())?.person;
  if (!person) return null;
  const t = await getTranslate();
  return (
    <RecordPresence
      table={table}
      id={id}
      me={{ key: person.id, name: person.fullName ?? t("collab.history.someone") }}
    />
  );
}
