/**
 * The budget grid's read-only Account column shows the account the saved line posts to, as
 * app.budget_line_amounts reports it (BudgetLine.accountCode), not the URID class's account. Decision
 * 39 reads ruling D13 as letting an item's explicit GL default come first: a line pricing the vendor
 * deposit 0000.51.01-XOS-005 posts to 1500 although its class, 0000, gives 5000 (pgTAP 1611), and the
 * budget's account pivot already says 1500. Rendered with the real editor; the @xos/ui grid records
 * the columns and rows it is given. A typed or saved change of URID or item blanks the account until
 * the page rereads the line (lib/finance/live-lines.ts, mergeSavedLine).
 */
import type { BudgetLine, BudgetLineInput } from "@xos/data/finance";
import { getMessages } from "@xos/i18n";
import type * as Ui from "@xos/ui";
import type { GridColumn } from "@xos/ui";
import { NextIntlClientProvider } from "next-intl";
import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { linesAfterSave, lineSaveOutcome, mergeLines, typedLine } from "@/lib/finance/live-lines";

type Row = Record<string, string | number | null>;

const seen = vi.hoisted(() => ({
  grids: [] as { columns: GridColumn[]; rows: Row[] }[],
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/app/[org]/finance/actions", () => ({
  addBudgetLinesAction: vi.fn(),
  deleteBudgetLinesAction: vi.fn(),
  drawContingencyAction: vi.fn(),
  searchCatalogAction: vi.fn(),
  updateBudgetLineAction: vi.fn(),
}));
vi.mock("@xos/ui", async (importOriginal) => {
  const ui = await importOriginal<typeof Ui>();
  return {
    ...ui,
    SpreadsheetGrid: (props: { columns: GridColumn[]; rows: Row[] }) => {
      seen.grids.push(props);
      return null;
    },
  };
});

const { BudgetEditor } = await import("@/components/finance/budget-editor");

const messages = getMessages("en-US");
type IntlProps = ComponentProps<typeof NextIntlClientProvider>;
const intl: Omit<IntlProps, "children"> = { locale: "en-US", timeZone: "UTC", messages };

function render(element: ReactNode): string {
  return renderToStaticMarkup(createElement(NextIntlClientProvider, intl as IntlProps, element));
}

const T0 = "2027-01-01T00:00:00Z";
const T1 = "2027-01-01T00:00:05Z";

function line(
  id: string,
  urid: string,
  elementId: string | null,
  accountCode: string | null,
  updatedAt = T0,
): BudgetLine {
  return {
    id,
    budgetId: "b1",
    lineNumber: 1,
    description: id,
    lineType: "Cost",
    urid,
    costCenterId: null,
    gradeCode: null,
    elementId,
    quantity: 1,
    unitBasis: "Each",
    unitPriceMinor: 10000,
    xyz: "X",
    xyzBasis: "Declared",
    extendedMinor: 10000,
    accountCode,
    actualMinor: 0,
    drawnInMinor: 0,
    drawnOutMinor: 0,
    committedMinor: 0,
    committedWithheld: false,
    poLineCount: 0,
    otherCurrencyPoLineCount: 0,
    markupBp: null,
    clientUnitPriceMinor: null,
    excludedFromQuote: false,
    etcMinor: null,
    effectiveMarkupBp: null,
    effectiveClientUnitPriceMinor: null,
    clientExtendedMinor: null,
    marginMinor: null,
    currentBudgetMinor: 10000,
    remainingCommitmentMinor: 0,
    forecastEtcMinor: 10000,
    etcSource: "Derived",
    efcMinor: 10000,
    forwardExposureMinor: 10000,
    varianceAtCompletionMinor: 0,
    forecastWithheld: false,
    laborActualMinor: 0,
    laborUnpricedMinutes: 0,
    laborOtherCurrencyCount: 0,
    updatedAt,
  };
}

function inputOf(l: BudgetLine, over: Partial<BudgetLineInput> = {}): BudgetLineInput {
  return {
    description: l.description,
    lineType: l.lineType,
    urid: l.urid,
    costCenterId: l.costCenterId,
    gradeCode: l.gradeCode,
    elementId: l.elementId,
    quantity: l.quantity,
    unitBasis: l.unitBasis,
    unitPriceMinor: l.unitPriceMinor,
    xyz: l.xyz,
    xyzBasis: l.xyzBasis,
    ...over,
  };
}

/** The Account cells the editor gives the grid, in row order. */
function accountCells(lines: readonly BudgetLine[]): (string | number | null | undefined)[] {
  render(
    createElement(BudgetEditor, {
      org: "northwind-live",
      budgetId: "b1",
      projectId: "p1",
      me: null,
      currency: "USD",
      exponent: 2,
      lines,
      urids: [{ urid: "0000.51.01", name: "Deposits", xyz: null }],
      costCenters: [],
      grades: [],
      canWrite: true,
    }),
  );
  const grid = seen.grids.at(-1);
  const column = grid?.columns.find((c) => c.key === "account");
  if (!grid || !column) throw new Error("The grid has an Account column.");
  expect(column.editable).toBeFalsy();
  return grid.rows.map((r) => (column.derive ? column.derive(r) : r["account"]));
}

beforeEach(() => {
  seen.grids.length = 0;
});

describe("the budget grid's Account column (decision 39)", () => {
  it("shows the account the line posts to, the item's explicit default before the class's", () => {
    expect(
      accountCells([
        line("deposit", "0000.51.01", "0000.51.01-XOS-005", "1500"),
        line("fees", "0000.51.01", null, "5000"),
      ]),
    ).toEqual(["1500", "5000"]);
  });

  it("leaves a line no account resolves for blank", () => {
    expect(accountCells([line("unmapped", "0000.51.01", null, null)])).toEqual([null]);
  });

  it("blanks the account while a typed URID or item saves, and shows the reread one after", () => {
    const deposit = line("deposit", "0000.51.01", "0000.51.01-XOS-005", "1500");
    const typed = typedLine([deposit], "deposit", inputOf(deposit, { urid: "5000.01.01" }));
    expect(accountCells(typed)).toEqual([null]);
    const noItem = typedLine([deposit], "deposit", inputOf(deposit, { elementId: null }));
    expect(accountCells(noItem)).toEqual([null]);
    // The save returns only stored columns, so the account stays blank until the page rereads it.
    const saved = { ...line("deposit", "5000.01.01", "0000.51.01-XOS-005", null, T1) };
    const after = linesAfterSave(typed, deposit, lineSaveOutcome({ line: saved }));
    expect(accountCells(after)).toEqual([null]);
    const reread = mergeLines(after, [{ ...saved, accountCode: "1500" }], new Set()).lines;
    expect(accountCells(reread)).toEqual(["1500"]);
  });

  it("keeps the account while an edit leaves the URID and item as they were", () => {
    const deposit = line("deposit", "0000.51.01", "0000.51.01-XOS-005", "1500");
    const typed = typedLine([deposit], "deposit", inputOf(deposit, { quantity: 4 }));
    expect(accountCells(typed)).toEqual(["1500"]);
    const saved = { ...line("deposit", "0000.51.01", "0000.51.01-XOS-005", null, T1), quantity: 4 };
    expect(accountCells(linesAfterSave(typed, deposit, lineSaveOutcome({ line: saved })))).toEqual([
      "1500",
    ]);
  });
});
