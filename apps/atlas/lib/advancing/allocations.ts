import type { BulkConfig } from "@/components/bulk/types";
import type {
  Allocation,
  AllocationDisplayStatus,
  AllocationHolder,
  AllocationKind,
} from "@xos/data/allocations";
import type { RecordState } from "@xos/ui";

/**
 * The allocations page's rules in Atlas (R7), pure so they are unit tested: the chip each computed status takes, the
 * copy keys of kinds and statuses, the filters, the group order of the list, the people by kind matrix and the bulk
 * decision a reviewer gets.
 */

export const ALLOCATION_RECORD_STATE: Readonly<Record<AllocationDisplayStatus, RecordState>> = {
  Requested: "in-review",
  Approved: "ready",
  Reserved: "ready",
  "Awaiting Order": "proposed",
  "On Order": "scheduled",
  Confirmed: "scheduled",
  Received: "ready",
  "Partly Issued": "active",
  Issued: "active",
  Returned: "complete",
  Revoked: "canceled",
  Declined: "blocked",
  Withdrawn: "canceled",
};

/** The list's group order: what needs a decision first, finished last. */
export const STATUS_ORDER: readonly AllocationDisplayStatus[] = [
  "Requested",
  "Awaiting Order",
  "On Order",
  "Confirmed",
  "Received",
  "Reserved",
  "Approved",
  "Partly Issued",
  "Issued",
  "Returned",
  "Revoked",
  "Declined",
  "Withdrawn",
];

/** `Partly Issued` as `partly_issued`, the copy key of a status or kind. */
export const copyKey = (value: string) => value.toLowerCase().replace(/ /g, "_");

export interface AllocationFilters {
  readonly kind?: AllocationKind | undefined;
  readonly status?: AllocationDisplayStatus | undefined;
  readonly party?: string | undefined;
  /** Only allocations with a hold in conflict, by allocation id. */
  readonly conflicts?: ReadonlySet<string> | undefined;
}

/** The party an allocation belongs to: its pool's party, or the party of the person's engagement. */
export function partyOf(a: Allocation, holders: readonly AllocationHolder[]): string {
  const holder = a.rosterEntryId
    ? holders.find((h) => h.rosterEntryId === a.rosterEntryId)
    : holders.find((h) => h.kind === "Pool" && h.engagementId === a.holderEngagementId);
  return holder?.partyName ?? "";
}

/** The name shown for the holder: the person, or the party for a pool. */
export function holderOf(a: Allocation, holders: readonly AllocationHolder[]): string {
  const holder = a.rosterEntryId
    ? holders.find((h) => h.rosterEntryId === a.rosterEntryId)
    : holders.find((h) => h.kind === "Pool" && h.engagementId === a.holderEngagementId);
  return holder?.holderName ?? holder?.partyName ?? "";
}

/** The rows a filter shows; withdrawn and declined only when asked for by status. */
export function visibleAllocations(
  rows: readonly Allocation[],
  holders: readonly AllocationHolder[],
  filters: AllocationFilters,
): Allocation[] {
  return rows.filter(
    (a) =>
      (filters.kind ? a.kind === filters.kind : true) &&
      (filters.status
        ? a.status === filters.status
        : a.status !== "Withdrawn" && a.status !== "Declined") &&
      (filters.party ? partyOf(a, holders) === filters.party : true) &&
      (filters.conflicts ? filters.conflicts.has(a.id) : true),
  );
}

/** Rows grouped by status in STATUS_ORDER, each group in the order given; empty groups left out. */
export function groupByStatus(
  rows: readonly Allocation[],
): { status: AllocationDisplayStatus; rows: Allocation[] }[] {
  return STATUS_ORDER.map((status) => ({
    status,
    rows: rows.filter((a) => a.status === status),
  })).filter((g) => g.rows.length > 0);
}

/** One cell of the matrix: the person's allocations of one kind, with the status that leads. */
export interface MatrixCell {
  readonly quantity: number;
  readonly status: AllocationDisplayStatus;
  readonly ids: readonly string[];
}

export interface AllocationMatrix {
  readonly kinds: readonly AllocationKind[];
  readonly people: readonly {
    readonly rosterEntryId: string;
    readonly name: string;
    readonly party: string;
    readonly cells: Readonly<Partial<Record<AllocationKind, MatrixCell>>>;
  }[];
}

/**
 * People by kind (hand-rolled as the reconciliation matrix is): one row per person holding allocations, one column
 * per kind any of them holds, each cell the quantity and the status that comes first in STATUS_ORDER. Pools are not
 * people, so they stay in the list and table views.
 */
export function allocationMatrix(
  rows: readonly Allocation[],
  holders: readonly AllocationHolder[],
): AllocationMatrix {
  const kinds = new Set<AllocationKind>();
  const byPerson = new Map<string, Partial<Record<AllocationKind, MatrixCell>>>();
  for (const a of rows) {
    if (!a.rosterEntryId) continue;
    kinds.add(a.kind);
    const cells = byPerson.get(a.rosterEntryId) ?? {};
    const cell = cells[a.kind];
    const lead =
      cell && STATUS_ORDER.indexOf(cell.status) <= STATUS_ORDER.indexOf(a.status)
        ? cell.status
        : a.status;
    cells[a.kind] = {
      quantity: (cell?.quantity ?? 0) + a.quantity,
      status: lead,
      ids: [...(cell?.ids ?? []), a.id],
    };
    byPerson.set(a.rosterEntryId, cells);
  }
  const people = [...byPerson.entries()]
    .map(([rosterEntryId, cells]) => {
      const holder = holders.find((h) => h.rosterEntryId === rosterEntryId);
      return {
        rosterEntryId,
        name: holder?.holderName ?? "",
        party: holder?.partyName ?? "",
        cells,
      };
    })
    .sort((a, b) => a.party.localeCompare(b.party) || a.name.localeCompare(b.name));
  const order: readonly AllocationKind[] = [
    "Credential",
    "Parking Pass",
    "Asset",
    "Catering",
    "Lodging",
    "Travel",
    "Per Diem",
  ];
  return { kinds: order.filter((k) => kinds.has(k)), people };
}

/** The bulk decision a reviewer gets, or none: allocation_state to Approved or Declined, with one reason. */
export function allocationBulkConfig(
  org: string,
  canReview: boolean,
  labels: { readonly state: string; readonly approve: string; readonly decline: string },
): BulkConfig | null {
  if (!canReview) return null;
  return {
    org,
    resource: "advance_allocations",
    fields: [
      {
        key: "allocation_state",
        label: labels.state,
        reason: true,
        options: [
          { value: "Approved", label: labels.approve },
          { value: "Declined", label: labels.decline },
        ],
      },
    ],
  };
}

/** What a viewer may do with one allocation, from its state, kind and the page's abilities. */
export function allocationActions(
  a: Allocation,
  can: { readonly write: boolean; readonly review: boolean },
): readonly ("review" | "split" | "unsplit" | "issue" | "withdraw")[] {
  const out: ("review" | "split" | "unsplit" | "issue" | "withdraw")[] = [];
  if (a.state === "Requested" && can.review) out.push("review");
  if (
    a.state === "Approved" &&
    a.holderEngagementId !== null &&
    a.quantity > a.issuedQuantity &&
    can.write
  ) {
    out.push("split");
  }
  if (a.state === "Approved" && a.origin === "Split" && can.write) out.push("unsplit");
  if (
    a.state === "Approved" &&
    a.issuedQuantity < a.quantity &&
    (a.rosterEntryId !== null || a.kind === "Asset")
  ) {
    out.push("issue");
  }
  if ((a.state === "Requested" || a.state === "Approved") && can.write) out.push("withdraw");
  return out;
}
