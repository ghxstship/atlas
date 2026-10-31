import type { XosClient } from "@xos/data";
import { listMembers } from "@xos/data/identity";
import { listVenueContacts } from "@xos/data/local-contacts";
import { getLocale } from "next-intl/server";
import dynamic from "next/dynamic";
import { getOrgContext } from "@/lib/shell/context";
import { shownContacts } from "./shown";

/** The panel loads with an open venue only (B5). */
const LocalContactsPanel = dynamic(() => import("./panel").then((m) => m.LocalContactsPanel));

/**
 * The venue peek's Local contacts (B5, G-56): the venue's own rows, listed on the day sheets of every project there.
 * Writers need places.venue.write; member rows show the member's current name.
 */
export async function VenueContacts({
  db,
  org,
  venueId,
  canWrite,
}: {
  db: XosClient;
  org: string;
  venueId: string;
  canWrite: boolean;
}) {
  const [contacts, ctx, locale] = await Promise.all([
    listVenueContacts(db, venueId),
    getOrgContext(org),
    getLocale(),
  ]);
  if (!contacts.ok) return null;
  const members = canWrite && ctx ? await listMembers(db, ctx.org.id) : null;
  const names = new Map(
    (members?.ok ? members.data : []).map((m) => [m.membershipId, m.fullName ?? ""] as const),
  );
  return (
    <LocalContactsPanel
      org={org}
      namespace="places"
      home={{ venueId }}
      day={null}
      contacts={shownContacts(
        contacts.data.map((c) =>
          c.membershipId && !c.displayName
            ? { ...c, displayName: names.get(c.membershipId) ?? null }
            : c,
        ),
        locale,
      )}
      members={[...names.entries()].map(([membershipId, name]) => ({ membershipId, name }))}
      canWrite={canWrite}
    />
  );
}
