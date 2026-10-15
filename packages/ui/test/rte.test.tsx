import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RichTextEditor } from "../src/index.ts";
import {
  menuRenderer,
  slashCommands,
  type SuggestionMenu,
} from "../src/RichTextEditor/extensions.ts";
import { expectAccessible } from "./a11y.ts";

/* ProseMirror reads layout from point APIs jsdom leaves out; stubbed for these tests only. */
const original = document.elementFromPoint;
const rects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
beforeAll(() => {
  document.elementFromPoint = () => null;
  Range.prototype.getClientRects = rects;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Object.assign(Text.prototype, { getClientRects: rects });
});
afterAll(() => {
  document.elementFromPoint = original;
});

const people = [
  { id: "p1", label: "Dana Ortiz" },
  { id: "p2", label: "Sam Lee" },
];

describe("RichTextEditor blocks", () => {
  it("inserts a checklist and a table from the toolbar", async () => {
    const onChange = vi.fn();
    render(<RichTextEditor label="Notes" html="<p>Advance</p>" onChange={onChange} />);
    await userEvent.click(screen.getByRole("textbox", { name: "Notes" }));
    await userEvent.click(screen.getByRole("button", { name: "Checklist" }));
    await waitFor(() =>
      expect(String(onChange.mock.lastCall?.[0])).toContain('data-type="taskList"'),
    );
    await userEvent.click(screen.getByRole("button", { name: "Table" }));
    await waitFor(() => expect(String(onChange.mock.lastCall?.[0])).toContain("<table"));
    expect(screen.getByRole("button", { name: "Table" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("renders mentions and record links from stored HTML", () => {
    render(
      <RichTextEditor
        label="Doc"
        html='<p><span data-type="mention" data-id="p1" data-label="Dana Ortiz"></span> see <span data-type="recordLink" data-id="NW-TSK-12" data-label="Fire lane"></span></p>'
        mentions={() => people}
        records={() => []}
        recordHref={(urid) => `/records/${urid}`}
      />,
    );
    const box = screen.getByRole("textbox", { name: "Doc" });
    expect(box.textContent).toContain("@Dana Ortiz");
    const link = box.querySelector("a[data-urid]");
    expect(link?.getAttribute("href")).toBe("/records/NW-TSK-12");
    expect(link?.textContent).toBe("#Fire lane");
  });

  it("opens the slash menu, filters it and inserts a block", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <RichTextEditor label="Slash" html="<p></p>" onChange={onChange} mentions={() => people} />,
    );
    await userEvent.click(screen.getByRole("textbox", { name: "Slash" }));
    await userEvent.keyboard("/quo");
    const menu = await screen.findByRole("listbox", { name: "Blocks to insert" });
    expect(menu.textContent).toContain("Quote");
    await expectAccessible(container);
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(String(onChange.mock.lastCall?.[0])).toContain("<blockquote"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("mentions a person with the arrow keys", async () => {
    const onChange = vi.fn();
    render(
      <RichTextEditor label="Mention" html="<p></p>" onChange={onChange} mentions={() => people} />,
    );
    await userEvent.click(screen.getByRole("textbox", { name: "Mention" }));
    await userEvent.keyboard("@");
    await screen.findByRole("listbox", { name: "People to mention" });
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: "Sam Lee" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(String(onChange.mock.lastCall?.[0])).toContain('data-id="p2"'));
  });
});

describe("suggestion menu renderer", () => {
  it("moves, selects, escapes and reports no matches", () => {
    let menu: SuggestionMenu | null = null;
    const listen = () => (next: SuggestionMenu | null) => {
      menu = next;
    };
    const lifecycle = menuRenderer("record", listen)();
    const command = vi.fn();
    const base = {
      items: [
        { id: "a", label: "Alpha" },
        { id: "b", label: "Beta" },
      ],
      command,
      clientRect: () => new DOMRect(10, 20, 0, 16),
    };
    const key = (k: string) =>
      lifecycle.onKeyDown?.({ event: new KeyboardEvent("keydown", { key: k }) } as never);
    act(() => lifecycle.onStart?.(base as never));
    expect(menu).toMatchObject({ kind: "record", active: 0 });
    expect(key("ArrowUp")).toBe(true);
    expect((menu as SuggestionMenu | null)?.active).toBe(1);
    expect(key("x")).toBe(false);
    expect(key("Tab")).toBe(true);
    expect(command).toHaveBeenCalledWith({ id: "b", label: "Beta" });
    (menu as SuggestionMenu | null)?.select(0);
    expect(command).toHaveBeenLastCalledWith({ id: "a", label: "Alpha" });
    lifecycle.onUpdate?.({ ...base, items: [] } as never);
    expect(key("Enter")).toBe(false);
    expect(key("Escape")).toBe(true);
    expect(menu).toBeNull();
    expect(key("Enter")).toBe(false);
    lifecycle.onStart?.(base as never);
    lifecycle.onExit?.(base as never);
    expect(menu).toBeNull();
  });

  it("labels every slash block", () => {
    const labels = slashCommands((k) => k).map((c) => c.label);
    expect(labels).toEqual([
      "rte.heading",
      "rte.bullets",
      "rte.checklist",
      "rte.table",
      "rte.quote",
      "rte.divider",
    ]);
  });
});
