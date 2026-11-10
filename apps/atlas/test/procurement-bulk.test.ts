/**
 * Selection and bulk edit on the purchase order, RFQ and vendor collections (A120, Section 11.7):
 * each offers only the changes the person's capabilities allow, and nothing is selectable without
 * one. The collection kit's table selects rows, and a row's menu names the row and offers the
 * bulk changes. Rendered with the real components and catalog; the @xos/ui table records its props.
 */
import { getMessages } from "@xos/i18n";
import type * as Ui from "@xos/ui";
import type { RowActions } from "@/components/menus/use-row-menu";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CollectionView } from "@/components/collection-kit/collection-view";
import type { KitRow, ViewKind } from "@/components/collection-kit/types";
import {
  purchaseOrderBulk,
  rfqBulk,
  STANDARD_TERMS_DAYS,
  vendorBulk,
} from "@/lib/bulk/procurement";

type Props = Record<string, unknown>;

const seen = vi.hoisted(() => ({
  menus: [] as RowActions[],
  tables: [] as Props[],
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
  usePathname: () => "/demo-productions/vendors/directory",
  useSearchParams: () => new URLSearchParams("view=table"),
}));

vi.mock("@/components/menus/use-row-menu", () => ({
  useRowMenu: () => ({ open: (actions: RowActions) => seen.menus.push(actions), menu: null }),
}));

vi.mock("@xos/ui", async (importOriginal) => {
  const ui = await importOriginal<typeof Ui>();
  const { createElement: h } = await import("react");
  return {
    ...ui,
    DataTable: (props: Props) => {
      seen.tables.push(props);
      return h(ui.DataTable as never, props);
    },
  };
});

const messages = getMessages("en-US");
type Translate = (key: string, values?: Record<string, string | number>) => string;
const copy = (namespace: "procurement" | "vendors") =>
  createTranslator({ locale: "en-US", messages, namespace }) as unknown as Translate;
const procurement = copy("procurement");
const vendors = copy("vendors");

const ORG = "demo-productions";
const caps = (...codes: string[]) => new Set(codes);
const values = (config: ReturnType<typeof purchaseOrderBulk>, key: string) =>
  config?.fields.find((f) => f.key === key)?.options.map((o) => o.value);

beforeEach(() => {
  seen.menus.length = 0;
  seen.tables.length = 0;
});

describe("what a selection of purchase orders can change", () => {
  it("offers approving, sending, closing and cancelling, each asking for a reason", () => {
    const config = purchaseOrderBulk(
      ORG,
      caps("finance.po.approve", "procurement.po.send", "procurement.po.write"),
      procurement,
    );
    expect(config?.resource).toBe("purchase_orders");
    expect(config?.fields).toEqual([
      {
        key: "po_state",
        label: "State",
        reason: true,
        options: [
          { value: "Approved", label: "Approved" },
          { value: "Sent", label: "Sent" },
          { value: "Closed", label: "Closed" },
          { value: "Canceled", label: "Canceled" },
        ],
      },
    ]);
  });

  it("offers approval only to approvers, and sending only to senders", () => {
    expect(
      values(purchaseOrderBulk(ORG, caps("procurement.po.write"), procurement), "po_state"),
    ).toEqual(["Closed", "Canceled"]);
    expect(
      values(purchaseOrderBulk(ORG, caps("finance.po.approve"), procurement), "po_state"),
    ).toEqual(["Approved"]);
  });

  it("makes nothing selectable for someone who may only read orders", () => {
    expect(purchaseOrderBulk(ORG, caps("procurement.po.read"), procurement)).toBeNull();
  });
});

describe("what a selection of RFQs can change", () => {
  it("issues, closes or cancels, and never awards in bulk", () => {
    const config = rfqBulk(
      ORG,
      caps(
        "procurement.rfq.write",
        "procurement.rfq.issue",
        "procurement.bid.unseal",
        "procurement.bid.award",
      ),
      procurement,
    );
    expect(config?.resource).toBe("rfqs");
    expect(values(config, "rfq_state")).toEqual(["Issued", "Closed", "Canceled"]);
    expect(config?.fields[0]?.reason).toBe(true);
  });

  it("follows each move's capability", () => {
    expect(values(rfqBulk(ORG, caps("procurement.rfq.write"), procurement), "rfq_state")).toEqual([
      "Canceled",
    ]);
    expect(rfqBulk(ORG, caps("procurement.rfq.read"), procurement)).toBeNull();
  });
});

describe("what a selection of vendors can change", () => {
  it("needs vendors.vendor.write", () => {
    expect(
      vendorBulk(ORG, caps("vendors.vendor.read"), vendors, { currencies: ["USD"], terms: [] }),
    ).toBeNull();
  });

  it("moves vendors along their lifecycle and sets their terms and currency", () => {
    const config = vendorBulk(ORG, caps("vendors.vendor.write"), vendors, {
      currencies: ["EUR", "USD"],
      terms: [30, 7, null, 30],
    });
    expect(config?.resource).toBe("vendors");
    expect(config?.fields.map((f) => [f.key, f.label])).toEqual([
      ["vendor_state", "State"],
      ["payment_terms_days", "Payment terms"],
      ["default_currency_code", "Default currency"],
    ]);
    expect(values(config, "vendor_state")).toEqual(["Onboarded", "Active", "Blocked", "Canceled"]);
    // The standard terms and the ones vendors already have, once each, shortest first.
    expect(values(config, "payment_terms_days")).toEqual([
      null,
      ...[7, ...STANDARD_TERMS_DAYS].sort((a, b) => a - b),
    ]);
    const terms = config?.fields.find((f) => f.key === "payment_terms_days")?.options;
    expect(terms?.slice(0, 2)).toEqual([
      { value: null, label: "No terms set" },
      { value: 7, label: "7 days" },
    ]);
    expect(values(config, "default_currency_code")).toEqual([null, "EUR", "USD"]);
    // Bank details are never a bulk property.
    expect(config?.fields.some((f) => f.key.includes("bank") || f.key.includes("account"))).toBe(
      false,
    );
  });
});

type IntlProps = ComponentProps<typeof NextIntlClientProvider>;
const intl: Omit<IntlProps, "children"> = { locale: "en-US", timeZone: "UTC", messages };

function render(element: ReactNode): string {
  return renderToStaticMarkup(createElement(NextIntlClientProvider, intl as IntlProps, element));
}

const rows: KitRow[] = [
  {
    id: "v-1",
    key: "Equipment Rental",
    title: "Harborline Staging",
    label: "Harborline Staging",
    cells: { name: "Harborline Staging" },
  },
  {
    id: "v-2",
    key: "Equipment Rental",
    title: "Pierpoint Rigging",
    cells: { name: "Pierpoint Rigging" },
  },
];
const cell = { getBoundingClientRect: () => ({ left: 0, bottom: 0 }) };

function collection(view: ViewKind, bulk: ReturnType<typeof vendorBulk>) {
  return createElement(CollectionView, {
    title: "Vendor directory",
    views: ["table", "list"],
    view,
    columns: [{ key: "name", label: "Company name" }],
    rows,
    empty: null,
    bulk,
  });
}

describe("selection in the collection kit's table", () => {
  const config = vendorBulk(ORG, caps("vendors.vendor.write"), vendors, {
    currencies: ["USD"],
    terms: [],
  });

  it("makes the table's rows selectable and offers the bulk changes in a row's menu", () => {
    render(collection("table", config));
    const [table] = seen.tables;
    expect(table?.["selection"]).toMatchObject({ selected: new Set() });
    const menu = table?.["onRowContextMenu"] as (...args: unknown[]) => void;
    menu({ id: "v-1" }, 0, null, cell);
    expect(seen.menus[0]?.label).toBe("Harborline Staging");
    expect(seen.menus[0]?.bulk?.fields.map((f) => f.key)).toEqual([
      "vendor_state",
      "payment_terms_days",
      "default_currency_code",
    ]);
    // A row without its own label is named by its key.
    menu({ id: "v-2" }, 1, null, cell);
    expect(seen.menus[1]?.label).toBe("Equipment Rental");
  });

  it("selects nothing for a person who may not change the rows", () => {
    render(collection("table", null));
    expect(seen.tables[0]).not.toHaveProperty("selection");
    const menu = seen.tables[0]?.["onRowContextMenu"] as (...args: unknown[]) => void;
    menu({ id: "v-1" }, 0, null, cell);
    expect(seen.menus[0]?.bulk?.selection).toBeUndefined();
  });
});
