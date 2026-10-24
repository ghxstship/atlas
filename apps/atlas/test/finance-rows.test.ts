/**
 * The finance kit's table, list and board on a page with no record panel (Year-end, the chart of
 * accounts, the posting-line export): with `activatable={false}` a row opens nothing, so a click,
 * Enter or the row menu never puts the row's id in `?peek`, where the shell's peek would only say it
 * is no record. Rendered with the real components and catalog; the @xos/ui table, row and board
 * record the handlers they are given.
 */
import { getMessages } from "@xos/i18n";
import type * as Ui from "@xos/ui";
import type { RowActions } from "@/components/menus/use-row-menu";
import { NextIntlClientProvider } from "next-intl";
import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CollectionBoard } from "@/components/finance/kit-collection-board";
import { CollectionList } from "@/components/finance/kit-collection-list";
import { CollectionTable } from "@/components/finance/kit-collection-table";

type Props = Record<string, unknown>;

const seen = vi.hoisted(() => ({
  push: vi.fn<(href: string) => void>(),
  menus: [] as RowActions[],
  tables: [] as Props[],
  rows: [] as Props[],
  boards: [] as Props[],
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: seen.push, replace: seen.push }),
  usePathname: () => "/demo-productions/finance/chart-of-accounts",
  useSearchParams: () => new URLSearchParams("view=table"),
}));

vi.mock("@/components/menus/use-row-menu", () => ({
  useRowMenu: () => ({ open: (actions: RowActions) => seen.menus.push(actions), menu: null }),
}));

vi.mock("@xos/ui", async (importOriginal) => {
  const ui = await importOriginal<typeof Ui>();
  const { createElement: h } = await import("react");
  const recorded =
    <P extends object>(into: Props[], Component: (props: P) => ReactNode) =>
    (props: P) => {
      into.push(props as Props);
      return h(Component as never, props);
    };
  return {
    ...ui,
    DataTable: recorded(seen.tables, ui.DataTable),
    RecordRow: recorded(seen.rows, ui.RecordRow),
    Board: recorded(seen.boards, ui.Board),
  };
});

const messages = getMessages("en-US");
const finance = messages.finance as { common: { open: string; tableHint: string } };

type IntlProps = ComponentProps<typeof NextIntlClientProvider>;
const intl: Omit<IntlProps, "children"> = { locale: "en-US", timeZone: "UTC", messages };

function render(element: ReactNode): string {
  return renderToStaticMarkup(createElement(NextIntlClientProvider, intl as IntlProps, element));
}

type Handler = (...args: unknown[]) => void;
const handler = (props: Props | undefined, name: string) => props?.[name] as Handler | undefined;

const columns = [
  { key: "code", label: "Code" },
  { key: "name", label: "Name" },
];
const rows = [{ id: "1000", code: "1000", name: "Cash" }];
const items = [
  { id: "payee-1", recordKey: "TIN ••1234", title: "Ana Ruiz", state: "ready", stateLabel: "W-9" },
] as const;
const cell = { getBoundingClientRect: () => ({ left: 0, bottom: 0 }) };

beforeEach(() => {
  seen.push.mockClear();
  seen.menus.length = 0;
  seen.tables.length = 0;
  seen.rows.length = 0;
  seen.boards.length = 0;
});

describe("finance rows on a page with no record panel", () => {
  it("opens a table row's peek, its menu's Open and Open full page, and says Enter opens it", () => {
    const html = render(createElement(CollectionTable, { label: "Accounts", columns, rows }));
    const [table] = seen.tables;
    handler(table, "onRowActivate")?.(rows[0], 0);
    expect(seen.push).toHaveBeenCalledWith(
      "/demo-productions/finance/chart-of-accounts?view=table&peek=1000",
      { scroll: false },
    );
    handler(table, "onRowContextMenu")?.(rows[0], 0, null, cell);
    expect(seen.menus[0]?.open).toBeTypeOf("function");
    expect(seen.menus[0]?.href).toBe(
      "/demo-productions/finance/chart-of-accounts?view=table&peek=1000&full=1",
    );
    expect(html).toContain(finance.common.tableHint);
  });

  it("leaves a table row with no record panel inert: no ?peek, no Open, no Enter hint", () => {
    const html = render(
      createElement(CollectionTable, { label: "Accounts", columns, rows, activatable: false }),
    );
    const [table] = seen.tables;
    expect(table).toBeDefined();
    expect(handler(table, "onRowActivate")).toBeUndefined();
    // Nothing to select either, so the row has no menu at all.
    expect(handler(table, "onRowContextMenu")).toBeUndefined();
    expect(html).not.toContain(finance.common.tableHint);
    expect(seen.push).not.toHaveBeenCalled();
  });

  it("keeps a selectable row's menu without Open or Open full page", () => {
    render(
      createElement(CollectionTable, {
        label: "Accounts",
        columns,
        rows,
        activatable: false,
        bulk: { org: "demo-productions", resource: "records", fields: [] },
      }),
    );
    handler(seen.tables[0], "onRowContextMenu")?.(rows[0], 0, null, cell);
    expect(seen.menus).toHaveLength(1);
    expect(seen.menus[0]).not.toHaveProperty("open");
    expect(seen.menus[0]).not.toHaveProperty("href");
    expect(seen.menus[0]?.bulk?.selection).toBeDefined();
  });

  it("offers a list row's Open, and none on a page with no record panel", () => {
    const open = render(createElement(CollectionList, { label: "Payees", items }));
    expect(open).toContain(`>${finance.common.open}<`);
    handler(seen.rows[0], "onOpen")?.();
    expect(seen.push).toHaveBeenCalledWith(
      "/demo-productions/finance/chart-of-accounts?view=table&peek=payee-1",
      { scroll: false },
    );

    seen.push.mockClear();
    seen.rows.length = 0;
    const inert = render(
      createElement(CollectionList, { label: "Payees", items, activatable: false }),
    );
    expect(inert).toContain("Ana Ruiz");
    expect(inert).not.toContain(`>${finance.common.open}<`);
    const [row] = seen.rows;
    expect(row).toBeDefined();
    for (const name of ["onOpen", "onAction", "actionLabel"]) expect(row).not.toHaveProperty(name);
  });

  it("opens no card from a board on a page with no record panel", () => {
    const columnsByState = [
      {
        state: "ready",
        label: "Ready",
        cards: [{ key: "payee-1", title: "Ana Ruiz" }],
      },
    ] as const;
    render(createElement(CollectionBoard, { columns: columnsByState }));
    expect(handler(seen.boards[0], "onOpen")).toBeTypeOf("function");
    seen.boards.length = 0;
    render(createElement(CollectionBoard, { columns: columnsByState, activatable: false }));
    expect(seen.boards[0]).toBeDefined();
    expect(seen.boards[0]).not.toHaveProperty("onOpen");
  });
});
