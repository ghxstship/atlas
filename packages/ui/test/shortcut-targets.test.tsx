import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilterBuilder, SidePeek, TemplateCollection, TemplateRecord } from "../src/index.ts";
import {
  SHORTCUT_REGION,
  regionScope,
  runShortcut,
  shortcutControl,
  shortcutRegion,
} from "../src/lib/shortcut-targets.ts";

// jsdom lays nothing out; a control counts as shown unless it sits under data-test-hidden.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (
    this: HTMLElement,
  ) {
    return (this.closest("[data-test-hidden]") ? [] : [new DOMRect()]) as unknown as DOMRectList;
  });
});
afterEach(() => vi.restoreAllMocks());

describe("shortcut targets (Section 11.2)", () => {
  it("finds the region around focus, or the first region inside the focused container", () => {
    render(
      <div>
        <main tabIndex={-1}>
          <div data-shortcut-scope="view">
            <button type="button">In the view</button>
          </div>
        </main>
        <button type="button">Outside</button>
      </div>,
    );
    const inside = screen.getByRole("button", { name: "In the view" });
    expect(regionScope(shortcutRegion(inside))).toBe("view");
    expect(shortcutRegion(screen.getByRole("button", { name: "Outside" }))).toBeNull();
    expect(regionScope(shortcutRegion(screen.getByRole("main")))).toBe("view");
    expect(regionScope(shortcutRegion(document.body))).toBe("view");
    expect(shortcutRegion(null)).toBeNull();
    expect(regionScope(null)).toBeNull();
  });

  it("clicks the side peek's own controls and a clickable state", () => {
    const onOpenFull = vi.fn();
    const onCopyLink = vi.fn();
    const onStateClick = vi.fn();
    render(
      <SidePeek
        open
        recordKey="NWL-1042"
        kind="Inspection"
        title="Rigging inspection"
        state="in-review"
        stateLabel="In Review"
        onOpenFull={onOpenFull}
        onCopyLink={onCopyLink}
        onStateClick={onStateClick}
      >
        Activity
      </SidePeek>,
    );
    const peek = screen.getByRole("dialog", { name: "Rigging inspection" });
    expect(regionScope(peek)).toBe("record");
    expect(runShortcut(peek, "record.open")).toBe(true);
    expect(runShortcut(peek, "record.copy-link")).toBe(true);
    expect(runShortcut(peek, "record.state")).toBe(true);
    expect(onOpenFull).toHaveBeenCalledTimes(1);
    expect(onCopyLink).toHaveBeenCalledTimes(1);
    expect(onStateClick).toHaveBeenCalledTimes(1);
    // Nothing in this peek moves it to Trash, so the key goes on to the page.
    expect(runShortcut(peek, "record.trash")).toBe(false);
  });

  it("focuses fields and marked wrappers, and selects a title's text", () => {
    render(
      <TemplateRecord
        header={<h1>Rigging inspection</h1>}
        properties={
          <div data-shortcut="record.assign" className="contents">
            <select aria-label="Owner">
              <option>Dana Ortiz</option>
            </select>
          </div>
        }
      >
        <input aria-label="Title" data-shortcut="record.edit-title" defaultValue="Rigging" />
        <div data-shortcut="record.state" data-shortcut-focus="">
          <button type="button">Move to Done</button>
          <button type="button">Move to Blocked</button>
        </div>
        <textarea aria-label="Comment" data-shortcut="record.comment" />
      </TemplateRecord>,
    );
    const region = screen.getByRole("article");
    expect(regionScope(region)).toBe("record");
    const title = screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement;
    expect(runShortcut(region, "record.edit-title")).toBe(true);
    expect(document.activeElement).toBe(title);
    expect([title.selectionStart, title.selectionEnd]).toEqual([0, "Rigging".length]);
    expect(runShortcut(region, "record.state")).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move to Done" }));
    expect(runShortcut(region, "record.assign")).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Owner" }));
    expect(runShortcut(region, "record.comment")).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Comment" }));
  });

  it("prefers the selected option, skips disabled and hidden controls, and keeps a region's own", () => {
    const save = vi.fn();
    const exportView = vi.fn();
    const addFilter = vi.fn();
    const opened: string[] = [];
    render(
      <TemplateCollection
        header={
          <div data-shortcut="view.switch">
            <span role="radiogroup" aria-label="Views">
              <button type="button" role="radio" aria-checked="false">
                Table
              </button>
              <button type="button" role="radio" aria-checked="true">
                Board
              </button>
            </span>
            <button type="button" hidden data-shortcut="view.save" onClick={save} />
            <button
              type="button"
              aria-haspopup="menu"
              data-shortcut="view.menu"
              onClick={save}
              onKeyDown={(e) => opened.push(e.key)}
            >
              Saved views
            </button>
            <button type="button" data-shortcut="view.export" disabled onClick={exportView}>
              Export (disabled)
            </button>
            <span data-test-hidden="">
              <button type="button" data-shortcut="view.export" onClick={exportView}>
                Export (hidden)
              </button>
            </span>
            <FilterBuilder filters={[]} addLabel="Add filter" onAdd={addFilter} />
          </div>
        }
        filters={<input aria-label="Search" />}
      >
        <div data-shortcut-scope="record">
          <button type="button" data-shortcut="view.filters">
            Not this view&apos;s
          </button>
        </div>
      </TemplateCollection>,
    );
    // The collection template's root is the view region; nothing on it names the scope.
    const region = screen.getByRole("radiogroup").closest(SHORTCUT_REGION) as Element;
    expect(region.hasAttribute("data-shortcut-scope")).toBe(false);
    expect(regionScope(region)).toBe("view");
    expect(regionScope(shortcutRegion(screen.getByRole("textbox", { name: "Search" })))).toBe(
      "view",
    );
    // The selected option is focused, not clicked, so the arrow keys switch from there.
    expect(runShortcut(region, "view.switch")).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Board" }));
    expect(runShortcut(region, "view.save")).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(shortcutControl(region, "view.export")).toBeNull();
    expect(runShortcut(region, "view.export")).toBe(false);
    expect(exportView).not.toHaveBeenCalled();
    // A menu trigger opens on the arrow key, as menus open on a press rather than a click.
    expect(runShortcut(region, "view.menu")).toBe(true);
    expect(opened).toEqual(["ArrowDown"]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Saved views" }));
    // Open the filters presses the filter builder's Add filter; the nested record's button is its own.
    expect(runShortcut(region, "view.filters")).toBe(true);
    expect(addFilter).toHaveBeenCalledTimes(1);
  });

  it("focuses the filter row of a view without a filter builder, and leaves a view without either alone", () => {
    render(
      <>
        <TemplateCollection
          header={<h1>Projects</h1>}
          filters={
            <select aria-label="Phase">
              <option>Any</option>
            </select>
          }
        >
          <p>Rows</p>
        </TemplateCollection>
        <TemplateCollection header={<h1>Runs</h1>}>
          <button type="button">Row</button>
        </TemplateCollection>
      </>,
    );
    const region = shortcutRegion(screen.getByRole("combobox", { name: "Phase" })) as Element;
    expect(runShortcut(region, "view.filters")).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Phase" }));
    const bare = shortcutRegion(screen.getByRole("button", { name: "Row" })) as Element;
    expect(regionScope(bare)).toBe("view");
    expect(runShortcut(bare, "view.filters")).toBe(false);
  });
});
