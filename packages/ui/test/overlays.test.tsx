import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState as useStateHook } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  Accordion,
  BrandMark,
  Breadcrumbs,
  Button,
  CommandMenu,
  ContextMenu,
  Dialog,
  Drawer,
  DropdownMenu,
  HoverCard,
  OrgSwitcher,
  Pagination,
  Popover,
  SegmentedControl,
  ShortcutSheet,
  SidePeek,
  Sidebar,
  TabBar,
  Tabs,
  Tooltip,
  TopNav,
  XOSProvider,
  monogram,
  useHotkey,
} from "../src/index.ts";
import type { CommandMenuProps } from "../src/index.ts";
import { expectAccessible } from "./a11y.ts";

describe("Dialog", () => {
  it("opens from a trigger, traps focus, names itself and closes on Esc", async () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog
        title="Delete 3 Records"
        description="This cannot be undone."
        trigger={<Button>Delete</Button>}
        onOpenChange={onOpenChange}
        actions={<Button variant="danger">Delete</Button>}
      >
        Deleted records leave the audit log.
      </Dialog>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog", { name: "Delete 3 Records" });
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await expectAccessible(document.body);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("renders open while mounted when no trigger is given", async () => {
    render(
      <Dialog title="Archive Project" actions={<Button>Archive</Button>}>
        Body
      </Dialog>,
    );
    expect(screen.getByRole("dialog", { name: "Archive Project" })).toBeTruthy();
    await expectAccessible(document.body);
  });
});

describe("Drawer and SidePeek", () => {
  it("closes the drawer from its close button and reports onClose", async () => {
    const onClose = vi.fn();
    render(
      <Drawer title="Filters" side="left" footer={<Button>Apply</Button>} onClose={onClose}>
        Content
      </Drawer>,
    );
    const drawer = screen.getByRole("dialog", { name: "Filters" });
    await expectAccessible(document.body);
    await userEvent.click(within(drawer).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the record anatomy, resizes from the keyboard and keeps the page usable", async () => {
    const onOpenFull = vi.fn();
    const onStateClick = vi.fn();
    render(
      <div>
        <button type="button">List row</button>
        <SidePeek
          recordKey="NWL-1042"
          kind="Inspection"
          title="Rigging inspection"
          state="in-review"
          stateLabel="In Review"
          properties={[{ label: "Owner", value: "Dana Ortiz" }]}
          onOpenFull={onOpenFull}
          onStateClick={onStateClick}
        >
          Activity
        </SidePeek>
      </div>,
    );
    const peek = screen.getByRole("dialog", { name: "Rigging inspection" });
    expect(within(peek).getByText("NWL-1042")).toBeTruthy();
    expect(within(peek).getByText("Owner")).toBeTruthy();
    const handle = within(peek).getByRole("separator", { name: "Resize panel" });
    handle.focus();
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(handle.getAttribute("aria-valuenow")).toBe("592");
    await userEvent.keyboard("{ArrowRight}");
    expect(handle.getAttribute("aria-valuenow")).toBe("576");
    await userEvent.click(within(peek).getByRole("button", { name: "Open full page" }));
    await userEvent.click(within(peek).getByRole("button", { name: /In Review/ }));
    expect(onOpenFull).toHaveBeenCalled();
    expect(onStateClick).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "List row" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    await expectAccessible(document.body);
  });
});

describe("ShortcutSheet and useHotkey", () => {
  it("opens with ? through useHotkey and lists keys by group", async () => {
    function App() {
      const [open, setOpen] = useStateHook(false);
      useHotkey("?", () => setOpen(true));
      return (
        <ShortcutSheet
          open={open}
          onOpenChange={setOpen}
          groups={[{ label: "Navigation", items: [{ label: "Go to Projects", keys: "G P" }] }]}
        />
      );
    }
    render(<App />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(document, { key: "?" });
    const sheet = await screen.findByRole("dialog", { name: "Keyboard Shortcuts" });
    expect(within(sheet).getAllByText(/^[GP]$/)).toHaveLength(2);
    await expectAccessible(document.body);
  });

  it("ignores unmodified shortcuts while typing", () => {
    const handler = vi.fn();
    function App() {
      useHotkey("?", handler);
      return <input aria-label="Search" />;
    }
    render(<App />);
    fireEvent.keyDown(screen.getByLabelText("Search"), { key: "?" });
    expect(handler).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "?" });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("Popover, HoverCard and Tooltip", () => {
  it("opens a popover from its trigger with a Learn more link", async () => {
    render(
      <Popover title="Gate readiness" learnMore="/help/gates" trigger={<Button>Why</Button>}>
        Blocking criteria must be met before a gate advances.
      </Popover>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Why" }));
    expect(screen.getByRole("dialog", { name: "Gate readiness" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Learn more/ }).getAttribute("href")).toBe(
      "/help/gates",
    );
    await expectAccessible(document.body);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders static popover, hover card and tooltip bubbles", async () => {
    const { container } = render(
      <div>
        <Popover title="About">Text</Popover>
        <HoverCard
          recordKey="NWL-7"
          kind="Task"
          title="Hang truss"
          state="active"
          stateLabel="Active"
          owner="Dana"
          next="Nov 3"
        />
        <Tooltip label="Search" shortcut="⌘ K" />
      </div>,
    );
    expect(screen.getByRole("group", { name: "About" })).toBeTruthy();
    expect(screen.getByText("Hang truss")).toBeTruthy();
    expect(screen.getByRole("tooltip").textContent).toContain("Search");
    await expectAccessible(container);
  });

  it("shows a tooltip on focus and a hover card on hover", async () => {
    render(
      <div>
        <Tooltip label="Filter" shortcut="F">
          <button type="button" aria-label="Filter">
            F
          </button>
        </Tooltip>
        <HoverCard
          recordKey="NWL-7"
          kind="Task"
          title="Hang truss"
          state="active"
          stateLabel="Active"
          owner="Dana"
          next="Nov 3"
          openDelay={0}
        >
          <a href="/r/7">NWL-7</a>
        </HoverCard>
      </div>,
    );
    act(() => screen.getByRole("button", { name: "Filter" }).focus());
    expect((await screen.findAllByText("Filter")).length).toBeGreaterThan(0);
    await userEvent.hover(screen.getByRole("link", { name: "NWL-7" }));
    expect(await screen.findByText("Hang truss")).toBeTruthy();
    await expectAccessible(document.body);
  });

  it("opens a tooltip on a long press", () => {
    vi.useFakeTimers();
    render(
      <Tooltip label="Torch">
        <button type="button" aria-label="Torch">
          T
        </button>
      </Tooltip>,
    );
    const button = screen.getByRole("button", { name: "Torch" });
    fireEvent.pointerDown(button, { pointerType: "touch" });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    fireEvent.pointerUp(button, { pointerType: "touch" });
    expect(screen.getAllByText("Torch").length).toBeGreaterThan(1);
    vi.useRealTimers();
  });
});

const menuItems = [
  { heading: "Record" },
  { label: "Edit", icon: "Pencil", shortcut: "E", onSelect: vi.fn() },
  { label: "Move", submenu: true, items: [{ label: "To Board", onSelect: vi.fn() }] },
  { separator: true },
  { label: "Delete", icon: "Trash2", danger: true, onSelect: vi.fn() },
];

describe("menus", () => {
  it("opens a dropdown from the keyboard, moves with arrows and selects with Enter", async () => {
    const onSelect = vi.fn();
    render(
      <DropdownMenu
        label="Actions"
        icon="Ellipsis"
        items={[
          { label: "Edit", onSelect },
          { label: "Duplicate", active: true },
        ]}
      />,
    );
    const trigger = screen.getByRole("button", { name: /Actions/ });
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(2);
    await expectAccessible(document.body);
    await userEvent.keyboard("{ArrowDown}{ArrowUp}{Enter}");
    expect(onSelect).toHaveBeenCalled();
  });

  it("renders headings, separators, danger items and submenus", async () => {
    render(<DropdownMenu label="More" items={menuItems} defaultOpen />);
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Record")).toBeTruthy();
    expect(within(menu).getByRole("separator")).toBeTruthy();
    const move = within(menu).getByRole("menuitem", { name: /Move/ });
    move.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(await screen.findByRole("menuitem", { name: "To Board" })).toBeTruthy();
  });

  it("opens the context menu on right-click over its region", async () => {
    render(
      <ContextMenu items={menuItems}>
        <div tabIndex={0}>Row</div>
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText("Row"));
    expect(await screen.findByRole("menu", { name: "Actions" })).toBeTruthy();
    await expectAccessible(document.body);
  });

  it("renders a static context menu and runs items from the keyboard", async () => {
    const onSelect = vi.fn();
    const { container } = render(
      <ContextMenu
        label="Row actions"
        items={[
          { heading: "Row" },
          { label: "Open", onSelect },
          { separator: true },
          { label: "Delete", danger: true },
        ]}
      />,
    );
    const item = screen.getByRole("menuitem", { name: "Open" });
    fireEvent.keyDown(item, { key: "Enter" });
    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledTimes(2);
    await expectAccessible(container);
  });

  it("switches orgs and opens the marketplace", async () => {
    const onSelect = vi.fn();
    const onMarketplace = vi.fn();
    render(
      <OrgSwitcher
        current="Northwind Live"
        heading="Your Orgs"
        orgs={[
          { name: "Northwind Live", role: "Producer" },
          { name: "Harbor Light Events", role: "Crew", badge: 3 },
        ]}
        onSelect={onSelect}
        onMarketplace={onMarketplace}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Northwind Live" }));
    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getByRole("menuitemradio", { name: /Northwind Live/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await expectAccessible(document.body);
    await userEvent.click(within(menu).getByRole("menuitemradio", { name: /Harbor Light/ }));
    expect(onSelect).toHaveBeenCalledWith("Harbor Light Events");
    await userEvent.click(screen.getByRole("button", { name: "Northwind Live" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Browse Marketplace" }));
    expect(onMarketplace).toHaveBeenCalled();
  });
});

const runRigging = vi.fn();
const groups: CommandMenuProps["groups"] = [
  {
    label: "Records",
    items: [
      {
        label: "Rigging inspection",
        code: "NWL-1042",
        state: "in-review",
        onSelect: runRigging,
      },
      { label: "Hang truss", code: "NWL-7", selected: true },
    ],
  },
  { label: "Actions", items: [{ label: "Create Record", icon: "Plus", shortcut: "C" }] },
];

describe("CommandMenu", () => {
  it("filters as you type and runs the highlighted item with Enter", async () => {
    const onQueryChange = vi.fn();
    const { container } = render(
      <CommandMenu
        placeholder="Search or run a command"
        groups={groups}
        onQueryChange={onQueryChange}
      />,
    );
    const input = screen.getByRole("combobox");
    await userEvent.type(input, "rigging");
    expect(onQueryChange).toHaveBeenLastCalledWith("rigging");
    expect(screen.queryByText("Hang truss")).toBeNull();
    await userEvent.keyboard("{Enter}");
    expect(runRigging).toHaveBeenCalled();
    await userEvent.clear(input);
    await userEvent.type(input, "zzzz");
    expect(screen.getByText("No match. Try another word.")).toBeTruthy();
    await expectAccessible(container);
  });

  it("opens as a dialog on Cmd+K and closes after running an item", async () => {
    function App() {
      const [open, setOpen] = useStateHook(false);
      return <CommandMenu open={open} onOpenChange={setOpen} groups={groups} />;
    }
    render(<App />);
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Command menu" });
    await expectAccessible(document.body);
    await userEvent.click(within(dialog).getByText("Create Record"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Tabs, SegmentedControl and Accordion", () => {
  it("moves between tabs with arrows, Home and End and shows the matching panel", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <Tabs
        label="Project"
        onChange={onChange}
        tabs={[
          { value: "overview", label: "Overview" },
          { value: "scope", label: "Scope", count: 12 },
          { value: "budget", label: "Budget" },
        ]}
        panels={{ overview: "Overview body", scope: "Scope body", budget: "Budget body" }}
      />,
    );
    const first = screen.getByRole("tab", { name: "Overview" });
    first.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith("scope");
    expect(document.activeElement?.textContent).toContain("Scope");
    expect(screen.getByRole("tabpanel", { name: /Scope/ }).textContent).toBe("Scope body");
    await userEvent.keyboard("{End}");
    expect(onChange).toHaveBeenLastCalledWith("budget");
    await userEvent.keyboard("{Home}{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith("budget");
    await expectAccessible(container);
  });

  it("mirrors arrow keys in right-to-left", async () => {
    const onChange = vi.fn();
    render(
      <XOSProvider locale="ar-XB">
        <Tabs
          label="Tabs"
          onChange={onChange}
          tabs={[
            { value: "a", label: "A" },
            { value: "b", label: "B" },
          ]}
        />
      </XOSProvider>,
    );
    screen.getByRole("tab", { name: "A" }).focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith("b");
  });

  it("keeps exactly one segment on", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <SegmentedControl
        label="View"
        onChange={onChange}
        options={[
          { value: "list", label: "List", icon: "List" },
          { value: "board", label: "Board" },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole("radio", { name: /Board/ }));
    expect(onChange).toHaveBeenLastCalledWith("board");
    await userEvent.click(screen.getByRole("radio", { name: /Board/ }));
    expect(screen.getByRole("radio", { name: /Board/ }).getAttribute("aria-checked")).toBe("true");
    await expectAccessible(container);
  });

  it("toggles accordion sections with Enter", async () => {
    const { container } = render(
      <Accordion
        items={[
          { title: "More fields", meta: "6", open: true, content: "Fields" },
          { title: "Advanced", content: "Advanced body" },
        ]}
      />,
    );
    const advanced = screen.getByRole("button", { name: /Advanced/ });
    expect(advanced.getAttribute("aria-expanded")).toBe("false");
    advanced.focus();
    await userEvent.keyboard("{Enter}");
    expect(advanced.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Advanced body")).toBeTruthy();
    await expectAccessible(container);
  });
});

describe("navigation", () => {
  it("marks the current breadcrumb and pages with Previous and Next", async () => {
    const onNext = vi.fn();
    const { container } = render(
      <div>
        <Breadcrumbs
          items={[
            { label: "Northwind Live", href: "/" },
            { label: "Scope" },
            { label: "NWL-1042" },
          ]}
        />
        <Pagination summary="1 to 50 of 1,204" hasPrev={false} hasNext onNext={onNext} />
      </div>,
    );
    expect(screen.getByText("NWL-1042").getAttribute("aria-current")).toBe("page");
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(onNext).toHaveBeenCalled();
    await expectAccessible(container);
  });

  it("collapses sidebar groups and marks the active page", async () => {
    const onSelect = vi.fn();
    const { container } = render(
      <Sidebar
        active="Projects"
        groups={[
          {
            items: [
              { label: "Home", icon: "House", href: "/" },
              { label: "Inbox", icon: "Inbox", badge: 4, onSelect },
            ],
          },
          {
            label: "Work",
            items: [{ label: "Projects", icon: "FolderKanban", href: "/projects" }],
          },
          { label: "Finance", collapsed: true, items: [{ label: "Budget" }] },
        ]}
      />,
    );
    expect(screen.getByRole("link", { name: "Projects" }).getAttribute("aria-current")).toBe(
      "page",
    );
    const finance = screen.getByRole("button", { name: "Finance" });
    expect(finance.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Budget" })).toBeNull();
    await userEvent.click(finance);
    expect(screen.getByRole("button", { name: "Budget" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Inbox/ }));
    expect(onSelect).toHaveBeenCalled();
    await expectAccessible(container);
  });

  it("renders the Gateway top bar and the phone tab bar", async () => {
    const onSearch = vi.fn();
    const { container } = render(
      <div>
        <TopNav
          brand="Northwind Live"
          label="Gateway"
          person="Dana Ortiz"
          active="Home"
          onSearch={onSearch}
          items={[
            { label: "Home", icon: "House", href: "/" },
            { label: "Messages", icon: "MessageSquare", badge: 2 },
          ]}
        />
        <TabBar
          label="Compass"
          compass
          active="Today"
          centerLabel="Scan"
          items={[
            { label: "Today", icon: "Sun" },
            { label: "Scan", icon: "ScanLine" },
            { label: "Inbox", icon: "Inbox", badge: 3 },
          ]}
        />
      </div>,
    );
    expect(screen.getByRole("link", { name: /Home/ }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Account menu for Dana Ortiz" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Command menu" }));
    expect(onSearch).toHaveBeenCalled();
    expect(screen.getByRole("navigation", { name: "Compass" }).className).toContain("xos-compass");
    await expectAccessible(container);
  });
});

describe("BrandMark", () => {
  it("renders a monogram tile until logos are set, then the theme logo", async () => {
    const { container } = render(
      <div>
        <BrandMark name="Northwind Live" />
        <BrandMark name="Harbor Light" size="lg" iconOnly monogram="hl" />
        <BrandMark name="Acme" size="sm" logoLight="/l.svg" logoDark="/d.svg" />
        <BrandMark name="Solo" logoLight="/l.svg" />
      </div>,
    );
    expect(screen.getByRole("img", { name: "Northwind Live" }).textContent).toContain("NL");
    expect(screen.getByRole("img", { name: "Harbor Light" }).textContent).toBe("HL");
    expect(screen.getAllByRole("img", { name: "Acme" })).toHaveLength(1);
    expect(screen.getByRole("img", { name: "Solo" })).toBeTruthy();
    expect(monogram("A & B Co")).toBe("AB");
    await expectAccessible(container);
  });
});
