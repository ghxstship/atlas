import {
  extendedMinor,
  mergeSavedLine,
  type BudgetLine,
  type BudgetLineInput,
} from "@xos/data/finance";

/**
 * How the live budget grid reconciles its lines (Section 11.7, gap G-216): with each page render
 * someone else's change brings, with each save this tab makes, and with a cell that closes. Kept
 * apart from the editor so the rules that keep a typed value from being overwritten unseen are
 * tested on their own (packages/ui/test/grids.test.tsx checks the grid's half of them).
 */

export interface MergedLines {
  readonly lines: readonly BudgetLine[];
  /**
   * The grid rows, numbered from 1 as the grid showed them, of held lines the page no longer has:
   * someone else removed them while this person had a cell open or a save in flight.
   */
  readonly removedRows: readonly number[];
}

/**
 * Lines from a new page render merged into the editor's lines by id: rows added or removed elsewhere
 * come and go, and a line takes the page's version unless it is held (its cell is open or its save is
 * in flight) or the page's version is older than the one held, which a refresh that started before
 * this tab's own save can carry. A held line the page dropped is reported, so the person learns
 * their change was not saved; a line this tab deleted itself is not.
 */
export function mergeLines(
  current: readonly BudgetLine[],
  incoming: readonly BudgetLine[],
  held: ReadonlySet<string>,
  deletedHere: ReadonlySet<string> = new Set(),
): MergedLines {
  const mine = new Map(current.map((l) => [l.id, l]));
  const kept = new Set(incoming.map((l) => l.id));
  const lines = incoming.map((line) => {
    const known = mine.get(line.id);
    if (!known) return line;
    if (held.has(line.id) || line.updatedAt < known.updatedAt) return known;
    return line;
  });
  const removedRows = current.flatMap((l, i) =>
    held.has(l.id) && !kept.has(l.id) && !deletedHere.has(l.id) ? [i + 1] : [],
  );
  return { lines, removedRows };
}

/**
 * A line whose cell closed without a save catches up with the page, unless the page's version is
 * older than the one held or the page no longer has the line.
 */
export function catchUpLine(
  current: readonly BudgetLine[],
  page: readonly BudgetLine[],
  id: string,
): readonly BudgetLine[] {
  const theirs = page.find((l) => l.id === id);
  const mine = current.find((l) => l.id === id);
  if (!theirs || !mine || theirs.updatedAt < mine.updatedAt) return current;
  return current.map((l) => (l.id === id ? theirs : l));
}

/** The typed values of a line, shown at once while its save is in flight. */
export function typedLine(
  current: readonly BudgetLine[],
  id: string,
  input: BudgetLineInput,
): readonly BudgetLine[] {
  return current.map((l) =>
    l.id === id
      ? { ...l, ...input, extendedMinor: extendedMinor(input.quantity, input.unitPriceMinor) }
      : l,
  );
}

/** What updateBudgetLineAction answered, as far as the grid reads it. */
export interface LineSaveResult {
  readonly conflict?: BudgetLine;
  readonly line?: BudgetLine;
  readonly error?: { readonly kind: string };
}

export type LineSaveOutcome =
  /** Someone else saved first: the dialog shows both values and nothing is overwritten. */
  | { readonly kind: "conflict"; readonly theirs: BudgetLine }
  /** Someone else deleted the line: it leaves the grid and the person is told. */
  | { readonly kind: "removed" }
  | { readonly kind: "saved"; readonly line: BudgetLine }
  /** Refused for another reason: the line goes back to what it was. */
  | { readonly kind: "refused" };

export function lineSaveOutcome(result: LineSaveResult): LineSaveOutcome {
  if (result.conflict) return { kind: "conflict", theirs: result.conflict };
  if (result.error?.kind === "not-found") return { kind: "removed" };
  if (result.line) return { kind: "saved", line: result.line };
  return { kind: "refused" };
}

/** The editor's lines once a save of `previous` settles. A conflict leaves the typed values showing. */
export function linesAfterSave(
  current: readonly BudgetLine[],
  previous: BudgetLine,
  outcome: LineSaveOutcome,
): readonly BudgetLine[] {
  switch (outcome.kind) {
    case "conflict":
      return current;
    case "removed":
      return current.filter((l) => l.id !== previous.id);
    case "saved":
      return current.map((l) => (l.id === outcome.line.id ? mergeSavedLine(l, outcome.line) : l));
    case "refused":
      return current.map((l) => (l.id === previous.id ? previous : l));
  }
}

/** The version a later save of the line checks against, or null to keep the one it was typed at. */
export function savedVersion(outcome: LineSaveOutcome): string | null {
  return outcome.kind === "saved" ? outcome.line.updatedAt : null;
}

/**
 * Saves in flight per line, chained so a second edit of a line saves against the version the first
 * returns, never against the one it was typed at while the first was still saving.
 */
export class LineSaves {
  private readonly inflight = new Map<string, Promise<string | null>>();

  /** True while a save of the line is in flight. */
  has(id: string): boolean {
    return this.inflight.has(id);
  }

  /**
   * Runs `send` once any save of the line already in flight settles, with the version that save
   * returned, or `expected` when it returned none (a conflict, a refusal, a removed line). `send`
   * resolves to the new version or null. Resolves true when this was the line's last save in
   * flight, so the line is no longer saving.
   */
  async run(
    id: string,
    expected: string,
    send: (version: string) => Promise<string | null>,
  ): Promise<boolean> {
    const before = this.inflight.get(id);
    const run = (async () => send(before ? ((await before) ?? expected) : expected))();
    this.inflight.set(id, run);
    await run;
    if (this.inflight.get(id) !== run) return false;
    this.inflight.delete(id);
    return true;
  }
}
