import {
  awaitingSignature,
  isCurrentEngagement,
  onboardingStanding,
  recordDate,
  representationStanding,
  type ApplicationWithOpportunity,
  type Engagement,
  type EngagementDocument,
  type OnboardingItem,
  type Representation,
  type SharedRecord,
} from "@xos/data/gateway";
import {
  pendingRosterAnswers,
  type MyRosterEntry,
  type PendingInvitation,
  type UnconfirmedMembership,
} from "@xos/data/roster";

/**
 * Gateway Home (Section 4.5.8): the Up Next card for the person's next shift, set time, delivery
 * or deadline, then a feed of things that need them, each with its action inline. Pure functions
 * over repository results so the rules are testable without a database.
 */

/** Record kinds that make a dated thing to show up for (Section 3.10). */
export const UP_NEXT_KINDS = [
  "Shift",
  "Event",
  "Rehearsal",
  "Build",
  "Strike",
  "Booking",
  "Meeting",
  "Deadline",
  "Milestone",
  "Distribution",
] as const;

export type UpNext =
  | {
      readonly kind: "record";
      readonly record: SharedRecord;
      readonly engagement: Engagement | null;
    }
  | { readonly kind: "engagement"; readonly engagement: Engagement };

/** The soonest dated record ahead, else the next engagement to start. */
export function pickUpNext(
  records: readonly SharedRecord[],
  engagements: readonly Engagement[],
  now: Date,
): UpNext | null {
  const at = now.toISOString();
  const today = at.slice(0, 10);
  const ahead = records
    .filter((r) => (UP_NEXT_KINDS as readonly string[]).includes(r.kind))
    .filter((r) => r.state !== "Canceled" && r.state !== "Complete")
    .filter((r) => (r.endsAt ?? recordDate(r)) >= at)
    .sort((a, b) => recordDate(a).localeCompare(recordDate(b)));
  const next = ahead[0];
  if (next) {
    return {
      kind: "record",
      record: next,
      engagement: engagements.find((e) => e.projectId === next.projectId) ?? null,
    };
  }
  const starting = engagements
    .filter((e) => isCurrentEngagement(e) && (e.endDate ?? e.startDate) >= today)
    .sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
  return starting ? { kind: "engagement", engagement: starting } : null;
}

export type FeedItem =
  | {
      readonly kind: "sign";
      readonly document: EngagementDocument;
      readonly engagement: Engagement;
    }
  | { readonly kind: "offer"; readonly application: ApplicationWithOpportunity }
  | {
      readonly kind: "onboarding";
      readonly engagement: Engagement;
      readonly open: number;
      readonly blocking: number;
    }
  | { readonly kind: "representation"; readonly representation: Representation }
  | {
      readonly kind: "interview";
      readonly application: ApplicationWithOpportunity;
      readonly at: string;
    }
  | { readonly kind: "rate"; readonly engagement: Engagement }
  // R4: an invitation to an account or onto a roster, a membership to confirm, a roster entry to answer.
  | { readonly kind: "invitation"; readonly invitation: PendingInvitation }
  | { readonly kind: "membership"; readonly membership: UnconfirmedMembership }
  | { readonly kind: "roster"; readonly entry: MyRosterEntry };

/**
 * Things that need the person, most urgent first: invitations, memberships to confirm and roster
 * entries to answer (R4: nothing about the person flows until they do), documents to sign, offers to
 * answer, blocking onboarding, representations to accept, interviews ahead, then completed engagements
 * to rate.
 */
export function needsYou(input: {
  readonly engagements: readonly Engagement[];
  readonly documents: readonly EngagementDocument[];
  readonly onboarding: readonly OnboardingItem[];
  readonly applications: readonly ApplicationWithOpportunity[];
  readonly representations: readonly Representation[];
  readonly invitations?: readonly PendingInvitation[];
  readonly memberships?: readonly UnconfirmedMembership[];
  readonly rosterEntries?: readonly MyRosterEntry[];
  readonly personId: string;
  readonly now: Date;
}): FeedItem[] {
  const today = input.now.toISOString().slice(0, 10);
  const byId = new Map(input.engagements.map((e) => [e.id, e]));
  const items: FeedItem[] = [];
  for (const invitation of input.invitations ?? []) items.push({ kind: "invitation", invitation });
  for (const membership of input.memberships ?? []) items.push({ kind: "membership", membership });
  for (const entry of pendingRosterAnswers(input.rosterEntries ?? [])) items.push({ kind: "roster", entry });
  for (const document of awaitingSignature(input.documents)) {
    const engagement = byId.get(document.engagementId);
    if (engagement) items.push({ kind: "sign", document, engagement });
  }
  for (const application of input.applications) {
    if (application.state === "Offered") items.push({ kind: "offer", application });
  }
  for (const engagement of input.engagements) {
    if (engagement.state !== "Onboarding" && engagement.state !== "Blocked") continue;
    const open = input.onboarding.filter(
      (i) => i.engagementId === engagement.id && onboardingStanding(i, today) !== "verified",
    );
    if (open.length > 0) {
      items.push({
        kind: "onboarding",
        engagement,
        open: open.length,
        blocking: open.filter((i) => i.blocking).length,
      });
    }
  }
  for (const representation of input.representations) {
    if (
      representation.artistPersonId === input.personId &&
      representationStanding(representation, today) === "pending"
    ) {
      items.push({ kind: "representation", representation });
    }
  }
  const nowIso = input.now.toISOString();
  for (const application of input.applications) {
    const upcoming = application.interviews.find((i) => i.scheduledAt >= nowIso);
    if (upcoming) items.push({ kind: "interview", application, at: upcoming.scheduledAt });
  }
  for (const engagement of input.engagements) {
    if (
      engagement.state === "Complete" &&
      (engagement.endDate ?? engagement.startDate) >= isoDaysAgo(input.now, 14)
    ) {
      items.push({ kind: "rate", engagement });
    }
  }
  return items;
}

function isoDaysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

/** How many things to bring the Up Next card lists before it says how many more there are. */
export const BRING_LIMIT = 5;

export type UpNextCallKind = "shift" | "dockSlot" | "set";

const CALL_KINDS: Readonly<Record<string, UpNextCallKind>> = {
  Shift: "shift",
  "Dock Slot": "dockSlot",
  Set: "set",
};

export interface UpNextDetails {
  /** The next call while the operational area is open: when, in which zone, and what it is. */
  readonly call: {
    readonly at: string;
    readonly timeZone: string;
    readonly kind: UpNextCallKind;
  } | null;
  /** The venue's name and address, joined; null when the project names no venue. */
  readonly where: string | null;
  /** Whom to ask: the member who set up the engagement, else the org. */
  readonly contact: string;
  /** Badge categories, then gear with its asset tag, at most BRING_LIMIT. */
  readonly bring: readonly string[];
  /** How many more things to bring than the list shows. */
  readonly bringMore: number;
}

/**
 * What the Up Next card adds for an engagement (R2, api_external.engagement_up_next): the next call,
 * where, whom to ask, and what to bring (the person's live badges on the project and the gear the
 * engagement holds). Parking stays out until passes exist (R7, R8).
 */
export function upNextDetails(input: {
  readonly row: {
    readonly venue_name: string | null;
    readonly venue_street_address: string | null;
    readonly venue_locality: string | null;
    readonly venue_postal_code: string | null;
    readonly contact_name: string | null;
    readonly next_call_at: string | null;
    readonly next_call_time_zone: string | null;
    readonly next_call_kind: string | null;
  } | null;
  readonly orgName: string;
  readonly badges: readonly {
    readonly category_name: string | null;
    readonly revoked_at: string | null;
  }[];
  readonly gear: readonly {
    readonly class_name: string | null;
    readonly asset_tag: string | null;
  }[];
}): UpNextDetails {
  const row = input.row;
  const kind = row?.next_call_kind ? CALL_KINDS[row.next_call_kind] : undefined;
  const call =
    row?.next_call_at && row.next_call_time_zone && kind
      ? { at: row.next_call_at, timeZone: row.next_call_time_zone, kind }
      : null;
  const place = row
    ? [row.venue_name, row.venue_street_address, row.venue_locality, row.venue_postal_code]
        .map((v) => v?.trim() ?? "")
        .filter((v) => v !== "")
    : [];
  const badges = [
    ...new Set(
      input.badges.flatMap((b) =>
        b.revoked_at === null && b.category_name ? [b.category_name] : [],
      ),
    ),
  ];
  const gear = input.gear.flatMap((g) =>
    g.class_name ? [g.asset_tag ? `${g.class_name} (${g.asset_tag})` : g.class_name] : [],
  );
  const all = [...badges, ...gear];
  return {
    call,
    where: place.length > 0 ? place.join(", ") : null,
    contact: row?.contact_name?.trim() || input.orgName,
    bring: all.slice(0, BRING_LIMIT),
    bringMore: Math.max(0, all.length - BRING_LIMIT),
  };
}
