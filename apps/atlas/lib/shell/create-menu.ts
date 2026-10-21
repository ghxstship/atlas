import { fillRoute, getNode, isNodeVisible, type NavContext, type Sitemap } from "@xos/ia";
import type { CreateItem } from "./create-order";
import { NAV_ICONS } from "./nav-model";

/**
 * The global Create menu (Section 4.10, Section 11.2): every kind a person may create, each opening
 * its page's create flow (`?create=1`, ia/routes.config.ts). A kind is offered only when the person
 * holds its capability (packages/schemas/capabilities.yaml) and may open its page, so modules an org
 * turned off and pages a role cannot see drop out. The database still decides every row a flow writes.
 */
export interface CreateKind {
  /** Stable id; its label is shell.create.kinds.<id>. */
  readonly id: string;
  /** Sitemap node of the org-level page whose create flow opens. */
  readonly node: string;
  readonly capability: string;
}

export const CREATE_KINDS: readonly CreateKind[] = [
  { id: "project", node: "projects.all", capability: "projects.project.create" },
  { id: "record", node: "work.all-records", capability: "work.record.write" },
  { id: "workOrder", node: "work.work-orders", capability: "work.work_order.write" },
  { id: "punchList", node: "work.punch-lists", capability: "work.punch_list.write" },
  { id: "milestone", node: "schedule.milestones", capability: "schedule.milestone.write" },
  { id: "runOfShow", node: "show.run-of-show", capability: "show.run_of_show.write" },
  { id: "advancePacket", node: "advancing.packets", capability: "advancing.packet.write" },
  { id: "venue", node: "places.venues", capability: "places.venue.write" },
  { id: "shipment", node: "logistics.shipments", capability: "logistics.shipment.write" },
  {
    id: "fulfillment",
    node: "hospitality.fulfillments",
    capability: "hospitality.fulfillment.write",
  },
  { id: "inspection", node: "safety.inspections", capability: "safety.inspection.write" },
  { id: "incident", node: "safety.incidents", capability: "safety.incident.write" },
  { id: "requisition", node: "people.requisitions", capability: "people.requisition.write" },
  { id: "posting", node: "opportunities.postings", capability: "opportunities.posting.write" },
  { id: "shift", node: "crew.shifts", capability: "crew.shift.write" },
  { id: "timeEntry", node: "crew.time-entries", capability: "crew.time_entry.write" },
  { id: "budget", node: "finance.budgets", capability: "finance.budget.write" },
  { id: "expense", node: "finance.expenses", capability: "finance.expense.write" },
  { id: "changeOrder", node: "finance.change-orders", capability: "finance.change_order.write" },
  { id: "invoice", node: "finance.invoices", capability: "finance.invoice.write" },
  { id: "rfq", node: "procurement.rfqs", capability: "procurement.rfq.write" },
  { id: "purchaseOrder", node: "procurement.purchase-orders", capability: "procurement.po.write" },
  { id: "vendor", node: "vendors.directory", capability: "vendors.vendor.write" },
  { id: "sop", node: "knowledge.sops", capability: "knowledge.sop.write" },
  { id: "document", node: "knowledge.documents", capability: "knowledge.document.write" },
];

export type { CreateItem } from "./create-order";

type Translate = (key: string) => string;

/** The Create menu entries a person may use, in menu order. */
export function createItems(
  sitemap: Sitemap,
  input: {
    readonly nav: NavContext;
    readonly capabilities: ReadonlySet<string>;
    readonly params: Record<string, string>;
    readonly t: Translate;
  },
): CreateItem[] {
  return CREATE_KINDS.flatMap((kind) => {
    if (!input.capabilities.has(kind.capability)) return [];
    if (!isNodeVisible(sitemap, kind.node, input.nav)) return [];
    const entry = getNode(sitemap, kind.node);
    if (entry.node.route === undefined) return [];
    // The icon of the section the page sits under (Finance for Budgets), as in the command menu.
    const section = entry.ancestors.find((a) => a.navigable)?.node.id ?? kind.node;
    return [
      {
        id: kind.id,
        label: input.t(`shell.create.kinds.${kind.id}`),
        icon: NAV_ICONS[section] ?? "Plus",
        page: fillRoute(entry.node.route, input.params),
      },
    ];
  });
}
