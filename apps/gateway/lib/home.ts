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
} from "@xos/data";

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
  | { readonly kind: "record"; readonly record: SharedRecord; readonly engagement: Engagement | null }
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
  | { readonly kind: "sign"; readonly document: EngagementDocument; readonly engagement: Engagement }
  | { readonly kind: "offer"; readonly application: ApplicationWithOpportunity }
  | {
      readonly kind: "onboarding";
      readonly engagement: Engagement;
      readonly open: number;
      readonly blocking: number;
    }
  | { readonly kind: "representation"; readonly representation: Representation }
  | { readonly kind: "interview"; readonly application: ApplicationWithOpportunity; readonly at: string }
  | { readonly kind: "rate"; readonly engagement: Engagement };

/**
 * Things that need the person, most urgent first: documents to sign, offers to answer, blocking
 * onboarding, representations to accept, interviews ahead, then completed engagements to rate.
 */
export function needsYou(input: {
  readonly engagements: readonly Engagement[];
  readonly documents: readonly EngagementDocument[];
  readonly onboarding: readonly OnboardingItem[];
  readonly applications: readonly ApplicationWithOpportunity[];
  readonly representations: readonly Representation[];
  readonly personId: string;
  readonly now: Date;
}): FeedItem[] {
  const today = input.now.toISOString().slice(0, 10);
  const byId = new Map(input.engagements.map((e) => [e.id, e]));
  const items: FeedItem[] = [];
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
    if (engagement.state === "Complete" && (engagement.endDate ?? engagement.startDate) >= isoDaysAgo(input.now, 14)) {
      items.push({ kind: "rate", engagement });
    }
  }
  return items;
}

function isoDaysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}
