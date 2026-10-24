/**
 * Selection, bulk edit and row menus on Projects, Work orders, Punch lists and Recurring (A119,
 * Section 11.7). Rendered with the real components and catalog; the @xos/ui table records the
 * props it is given, so each collection's table is checked for the selection prop, rows keyed by
 * the id its bulk RPC takes, and a row menu holding the same changes as the bar. The rule that a
 * change limited to some rows is offered only when every selected row allows it is checked too.
 */
import type { ProjectSummary } from "@xos/data/projects";
import type { RecordSummary } from "@xos/data/work";
import type { PunchItem, WorkOrder } from "@xos/data/work-orders";
import { getMessages } from "@xos/i18n";
import type * as Ui from "@xos/ui";
import type { RowActions } from "@/components/menus/use-row-menu";
import { NextIntlClientProvider } from "next-intl";
import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { allowedFields } from "@/components/bulk/fields";
import type { BulkConfig, BulkField } from "@/components/bulk/types";
import { useBulk, type Bulk } from "@/components/bulk/use-bulk";
import { ProjectCollection } from "@/components/projects/project-collection";
import { PunchCollection } from "@/components/work/punch";
import { RecurringCollection } from "@/components/work/recurring";
import { WorkOrderCollection } from "@/components/work/work-orders";

type Props = Record<string, unknown>;

const seen = vi.hoisted(() => ({
  push: vi.fn<(href: string) => void>(),
  menus: [] as RowActions[],
  tables: [] as Props[],
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: seen.push, replace: seen.push, refresh: () => undefined }),
  usePathname: () => "/demo-productions/work",
  useSearchParams: () => new URLSearchParams("view=table"),
}));

vi.mock("@/components/menus/use-row-menu", () => ({
  useRowMenu: () => ({ open: (actions: RowActions) => seen.menus.push(actions), menu: null }),
}));

// Server actions never run here; the collections only hand them to buttons.
vi.mock("@/components/work/work-order-actions", () => {
  const none = async () => ({ ok: true, data: null });
  return {
    addBidAction: none,
    awardWorkOrderAction: none,
    createPunchItemAction: none,
    createWorkOrderAction: none,
    deleteWorkOrderAction: none,
    priceBidAction: none,
    restoreWorkOrderAction: none,
    transitionWorkOrderAction: none,
    updateWorkOrderAction: none,
    withdrawBidAction: none,
  };
});

vi.mock("@xos/ui", async (importOriginal) => {
  const ui = await importOriginal<typeof Ui>();
  const { createElement: h } = await import("react");
  return {
    ...ui,
    DataTable: (props: Ui.DataTableProps) => {
      seen.tables.push(props as unknown as Props);
      return h(ui.DataTable, props);
    },
  };
});

const messages = getMessages("en-US");
type IntlProps = ComponentProps<typeof NextIntlClientProvider>;
const intl: Omit<IntlProps, "children"> = { locale: "en-US", timeZone: "UTC", messages };
const workCopy = messages.work as { workOrders: { delete: string } };

function render(element: ReactNode): string {
  return renderToStaticMarkup(createElement(NextIntlClientProvider, intl as IntlProps, element));
}

type Handler = (...args: unknown[]) => void;
const handler = (props: Props | undefined, name: string) => props?.[name] as Handler | undefined;
const cell = { getBoundingClientRect: () => ({ left: 0, bottom: 0 }) };
const tableRows = (props: Props | undefined) => (props?.["rows"] ?? []) as Props[];

const ORG = "demo-productions";
const stateField: BulkField = {
  key: "state",
  label: "State",
  options: [{ value: "Open", label: "Open" }],
  rows: ["a", "b"],
};
const ownerField: BulkField = {
  key: "owner_party_id",
  label: "Owner",
  options: [{ value: null, label: "Unassigned" }],
};

const project = (id: string, key: string): ProjectSummary => ({
  id,
  key,
  name: `${key} Weekend`,
  description: null,
  currency: "USD",
  projectState: "Proposed",
  productionState: "Proposed",
  phaseCode: "SCP",
  jurisdictionId: null,
  regionCode: null,
  tierCode: null,
  timeZone: "America/New_York",
  startsOn: null,
  endsOn: null,
  venueId: null,
  venueName: null,
  workspaceId: null,
  archivedAt: null,
  updatedAt: "2026-10-24T12:00:00Z",
});

const record = (id: string, key: string, state = "Proposed"): RecordSummary =>
  ({
    id,
    key,
    title: `Correct ${key}`,
    state,
    ownerName: null,
    dueAt: null,
    timeZone: null,
    projectTimeZone: "America/New_York",
  }) as unknown as RecordSummary;

const order = (id: string, key: string, state: string): WorkOrder =>
  ({
    id,
    key,
    title: `Rig ${key}`,
    state,
    bids: [],
    budgetMinor: null,
    currencyCode: "USD",
    scheduledEndsAt: null,
    timeZone: "America/New_York",
  }) as unknown as WorkOrder;

beforeEach(() => {
  seen.push.mockClear();
  seen.menus.length = 0;
  seen.tables.length = 0;
});

describe("the changes a selection allows", () => {
  it("offers a change limited to some rows only when every selected row is listed", () => {
    const fields = [stateField, ownerField];
    expect(allowedFields(fields, ["a", "b"]).map((f) => f.key)).toEqual([
      "state",
      "owner_party_id",
    ]);
    expect(allowedFields(fields, ["a", "c"]).map((f) => f.key)).toEqual(["owner_party_id"]);
    expect(allowedFields(fields, ["c"]).map((f) => f.key)).toEqual(["owner_party_id"]);
  });

  it("allows every change with nothing selected, in the page's order", () => {
    expect(allowedFields([ownerField, stateField], []).map((f) => f.key)).toEqual([
      "owner_party_id",
      "state",
    ]);
    expect(allowedFields([ownerField, stateField], new Set<string>())).toHaveLength(2);
  });

  it("gives a row's menu the changes that row allows, and none without a config", () => {
    const config: BulkConfig = { org: ORG, resource: "work_orders", fields: [stateField] };
    let kit: Bulk | null = null;
    let none: Bulk | null = null;
    const Probe = () => {
      kit = useBulk(config, [
        { id: "a", label: "NWS-WO-1" },
        { id: "c", label: "NWS-WO-3" },
      ]);
      none = useBulk(null, [{ id: "a", label: "NWS-WO-1" }]);
      return null;
    };
    render(createElement(Probe));
    const got = kit as unknown as Bulk;
    expect(got.selection?.selected.size).toBe(0);
    expect(got.fieldsFor("a").map((f) => f.key)).toEqual(["state"]);
    expect(got.fieldsFor("c")).toEqual([]);
    expect(got.fields).toEqual([stateField]);
    const off = none as unknown as Bulk;
    expect(off.selection).toBeUndefined();
    expect(off.fieldsFor("a")).toEqual([]);
  });
});

describe("selection and row menus on each collection's table", () => {
  it("Projects: rows select by project id and each row's menu holds the bar's changes", () => {
    const bulk: BulkConfig = { org: ORG, resource: "projects", fields: [ownerField] };
    const props = {
      org: ORG,
      title: "All projects",
      projects: [project("p-1", "NWS"), project("p-2", "SHW")],
      phases: [],
      views: ["table"] as const,
      view: "table" as const,
      includeArchived: false,
      month: "2026-10-01",
      today: "2026-10-24",
      create: null,
    };
    render(createElement(ProjectCollection, { ...props, bulk }));
    const [table] = seen.tables;
    expect(table?.["selection"]).toBeDefined();
    expect(tableRows(table).map((r) => r["id"])).toEqual(["p-1", "p-2"]);
    handler(table, "onRowContextMenu")?.(tableRows(table)[1], 1, null, cell);
    expect(seen.menus[0]).toMatchObject({ id: "p-2", label: "SHW" });
    expect(seen.menus[0]?.bulk?.fieldsFor("p-2").map((f) => f.key)).toEqual(["owner_party_id"]);
    expect(seen.menus[0]?.href).toContain("SHW");

    seen.tables.length = 0;
    render(createElement(ProjectCollection, { ...props, bulk: null }));
    expect(seen.tables[0]?.["selection"]).toBeUndefined();
  });

  it("Work orders: a Draft row's menu deletes it as its peek does; other rows have no Delete", () => {
    const bulk: BulkConfig = {
      org: ORG,
      resource: "work_orders",
      fields: [{ ...stateField, rows: ["w-1"] }],
    };
    render(
      createElement(WorkOrderCollection, {
        org: ORG,
        title: "Work orders",
        orders: [order("w-1", "NWS-WO-1", "Draft"), order("w-2", "NWS-WO-2", "Complete")],
        total: 2,
        views: ["table"],
        view: "table",
        states: [],
        q: "",
        state: "",
        create: null,
        peek: null,
        canCreate: true,
        bulk,
      }),
    );
    const [table] = seen.tables;
    expect(table?.["selection"]).toBeDefined();
    expect(tableRows(table).map((r) => r["id"])).toEqual(["w-1", "w-2"]);
    handler(table, "onRowContextMenu")?.(tableRows(table)[0], 0, null, cell);
    handler(table, "onRowContextMenu")?.(tableRows(table)[1], 1, null, cell);
    const [draft, complete] = seen.menus;
    expect(draft?.more?.map((m) => ("label" in m ? m.label : null))).toEqual([
      workCopy.workOrders.delete,
    ]);
    expect(draft?.bulk?.fieldsFor("w-1").map((f) => f.key)).toEqual(["state"]);
    // A Complete work order has no state to move to, so its menu offers no change.
    expect(complete?.more).toBeUndefined();
    expect(complete?.bulk?.fieldsFor("w-2")).toEqual([]);
    expect(complete?.href).toContain("peek=w-2");
  });

  it("Punch lists: rows select by punch item id, named by the record key", () => {
    const items = [
      { id: "i-1", record: record("r-1", "NWS-12"), zoneName: null, locationText: "Stair B" },
      { id: "i-2", record: record("r-2", "NWS-13"), zoneName: null, locationText: null },
    ] as unknown as PunchItem[];
    render(
      createElement(PunchCollection, {
        org: ORG,
        title: "Punch lists",
        items,
        total: 2,
        views: ["table"],
        view: "table",
        states: [],
        state: "",
        projects: [],
        people: [],
        canCreate: true,
        open: false,
        peek: null,
        bulk: { org: ORG, resource: "punch_items", fields: [ownerField] },
      }),
    );
    const [table] = seen.tables;
    expect(table?.["selection"]).toBeDefined();
    expect(tableRows(table).map((r) => r["id"])).toEqual(["i-1", "i-2"]);
    handler(table, "onRowContextMenu")?.(tableRows(table)[1], 1, null, cell);
    expect(seen.menus[0]).toMatchObject({ id: "i-2", label: "NWS-13", href: `/${ORG}/r/NWS-13` });
    handler(table, "onRowActivate")?.(tableRows(table)[1], 1);
    expect(seen.push).toHaveBeenCalledWith("/demo-productions/work?view=table&peek=NWS-13", {
      scroll: false,
    });
  });

  it("Recurring: rows select by record id for the records bulk RPC", () => {
    render(
      createElement(RecurringCollection, {
        org: ORG,
        title: "Recurring",
        items: [
          {
            record: record("r-7", "NWS-7", "Active"),
            rule: "Every day",
            timeZone: "UTC",
            next: [],
          },
        ],
        views: ["table"],
        view: "table",
        month: "2026-10-01",
        today: "2026-10-24",
        peek: null,
        bulk: { org: ORG, resource: "records", fields: [ownerField] },
      }),
    );
    const [table] = seen.tables;
    expect(table?.["selection"]).toBeDefined();
    expect(tableRows(table).map((r) => r["id"])).toEqual(["r-7"]);
    handler(table, "onRowContextMenu")?.(tableRows(table)[0], 0, null, cell);
    expect(seen.menus[0]).toMatchObject({ id: "r-7", label: "NWS-7" });
    expect(seen.menus[0]?.bulk?.selection).toBeDefined();
  });
});
