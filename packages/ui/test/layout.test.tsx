import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  AppShell,
  BrandMark,
  Button,
  Card,
  PageHeader,
  ResizablePanel,
  ScrollRegion,
  SegmentedControl,
  Sidebar,
  SplitView,
  Stepper,
  TabBar,
  TemplateAuth,
  TemplateCollection,
  TemplateDashboard,
  TemplateDocument,
  TemplateGatewayShell,
  TemplateGridEditor,
  TemplateRecord,
  TemplateSettings,
  TemplateSplitView,
  TemplateSystem,
  TemplateWizard,
  XOSProvider,
} from "../src/index.ts";
import { expectAccessible } from "./a11y.ts";

const sidebar = (
  <Sidebar active="Home" groups={[{ items: [{ label: "Home", icon: "House", href: "/" }] }]} />
);

describe("AppShell", () => {
  it("lays out brand, sidebar, header and main, and opens the drawer below lg", async () => {
    const { container } = render(
      <AppShell
        brand={<BrandMark name="Northwind Live" size="sm" />}
        sidebar={sidebar}
        header={
          <PageHeader
            title="Projects"
            count={12}
            glyph="FolderKanban"
            actions={<Button variant="primary">Create Project</Button>}
          />
        }
        mobileNav={
          <TabBar label="Atlas" active="Home" items={[{ label: "Home", icon: "House" }]} />
        }
      >
        <Card>Body</Card>
      </AppShell>,
    );
    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Projects" })).toBeTruthy();
    const menu = screen.getByRole("button", { name: "Open navigation" });
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(menu);
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(menu.getAttribute("aria-controls") ?? "")).toBeTruthy();
    await expectAccessible(container);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(menu);
    await userEvent.click(menu);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(menu.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders without a header", () => {
    render(<AppShell sidebar={sidebar}>Body</AppShell>);
    expect(screen.getByText("Body")).toBeTruthy();
  });
});

describe("ResizablePanel and ScrollRegion", () => {
  it("resizes with arrow keys, Home and End within its limits", async () => {
    const onResize = vi.fn();
    const { container } = render(
      <ResizablePanel initial={240} min={200} max={360} label="Resize sidebar" onResize={onResize}>
        Panel
      </ResizablePanel>,
    );
    const handle = screen.getByRole("separator", { name: "Resize sidebar" });
    handle.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(handle.getAttribute("aria-valuenow")).toBe("256");
    await userEvent.keyboard("{End}");
    expect(handle.getAttribute("aria-valuenow")).toBe("360");
    await userEvent.keyboard("{ArrowRight}");
    expect(handle.getAttribute("aria-valuenow")).toBe("360");
    await userEvent.keyboard("{Home}{ArrowLeft}");
    expect(handle.getAttribute("aria-valuenow")).toBe("200");
    expect(onResize).toHaveBeenLastCalledWith(200);
    await expectAccessible(container);
  });

  it("resizes by pointer drag and mirrors keys for a left handle in right-to-left", async () => {
    render(
      <XOSProvider locale="ar-XB">
        <ResizablePanel initial={300} min={200} max={400} side="left">
          Panel
        </ResizablePanel>
      </XOSProvider>,
    );
    const handle = screen.getByRole("separator", { name: "Resize panel" });
    handle.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(handle.getAttribute("aria-valuenow")).toBe("316");
    fireEvent.pointerDown(handle, { clientX: 100 });
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 140 }));
      window.dispatchEvent(new MouseEvent("pointerup"));
    });
    expect(handle.getAttribute("aria-valuenow")).toBe("356");
  });

  it("joins the tab order only while it overflows", async () => {
    const width = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(900);
    const client = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
    const { container, unmount } = render(
      <ScrollRegion label="Budget lines">
        <table>
          <tbody>
            <tr>
              <td>Wide</td>
            </tr>
          </tbody>
        </table>
      </ScrollRegion>,
    );
    expect(screen.getByRole("region", { name: "Budget lines" }).getAttribute("tabindex")).toBe("0");
    await expectAccessible(container);
    unmount();
    width.mockReturnValue(300);
    render(<ScrollRegion label="Narrow">x</ScrollRegion>);
    expect(screen.getByRole("region", { name: "Narrow" }).hasAttribute("tabindex")).toBe(false);
    width.mockRestore();
    client.mockRestore();
  });
});

describe("Stepper and SplitView", () => {
  it("marks done and current steps", async () => {
    const { container } = render(<Stepper steps={["Details", "Crew", "Review"]} current={1} />);
    expect(screen.getByText("Crew").closest("li")?.getAttribute("aria-current")).toBe("step");
    expect(screen.queryByText("1")).toBeNull();
    expect(screen.getByText("3")).toBeTruthy();
    await expectAccessible(container);
  });

  it("moves through the list with arrows and selects with Enter", async () => {
    const onSelect = vi.fn();
    const { container } = render(
      <SplitView
        label="Inbox"
        selected={0}
        onSelect={onSelect}
        items={[
          { title: "Approve PO-112", meta: "2 h", state: "in-review" },
          { title: "Crew call posted", meta: "5 h" },
          { title: "Permit filed", meta: "1 d", state: "complete" },
        ]}
        detail={<p>Detail</p>}
      />,
    );
    const options = screen.getAllByRole("option");
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    options[0]?.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(options[1]);
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenLastCalledWith(1);
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(options[2]);
    await userEvent.click(options[2] as HTMLElement);
    expect(onSelect).toHaveBeenLastCalledWith(2);
    await expectAccessible(container);
  });
});

describe("templates", () => {
  it("compose collection, record, split view and dashboard slots", async () => {
    const { container } = render(
      <div>
        <TemplateCollection
          header={
            <PageHeader
              title="Records"
              views={<SegmentedControl label="View" options={[{ value: "list", label: "List" }]} />}
            />
          }
          filters={<span>Filters</span>}
          bulk={<span>Bulk</span>}
          peek={<span>Peek</span>}
        >
          List body
        </TemplateCollection>
        <TemplateRecord
          header={<h2>NWL-1042</h2>}
          properties={<p>Owner</p>}
          propertiesLabel="Properties"
          related={<p>Related</p>}
        >
          Content
        </TemplateRecord>
        <TemplateSplitView list={<p>List</p>} detail={<p>Detail</p>} listLabel="Resize list" />
        <TemplateDashboard header={<h2>Home</h2>}>
          <Card>Tile</Card>
        </TemplateDashboard>
      </div>,
    );
    expect(screen.getByRole("complementary", { name: "Properties" })).toBeTruthy();
    expect(screen.getByRole("separator", { name: "Resize list" })).toBeTruthy();
    await expectAccessible(container);
  });

  it("steps through the wizard and finishes on the last step", async () => {
    const onNext = vi.fn();
    const onBack = vi.fn();
    const { container, rerender } = render(
      <TemplateWizard
        steps={["Org", "Team"]}
        current={0}
        title="Create Org"
        onNext={onNext}
        onBack={onBack}
      >
        Step body
      </TemplateWizard>,
    );
    expect(screen.getByText("Step 1 of 2")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Previous/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onNext).toHaveBeenCalled();
    rerender(
      <TemplateWizard
        steps={["Org", "Team"]}
        current={1}
        title="Invite Team"
        onNext={onNext}
        onBack={onBack}
        finishLabel="Finish Setup"
      >
        Step body
      </TemplateWizard>,
    );
    expect(screen.getByRole("button", { name: "Finish Setup" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Previous/ }));
    expect(onBack).toHaveBeenCalled();
    await expectAccessible(container);
  });

  it("compose settings, grid editor, document, auth, gateway shell and system pages", async () => {
    const onAction = vi.fn();
    const { container } = render(
      <div>
        <TemplateSettings
          sections={<nav aria-label="Settings">Sections</nav>}
          saveBar={<Button>Save</Button>}
        >
          Form
        </TemplateSettings>
        <TemplateGridEditor header={<h2>Budget</h2>} toolbar={<Button>Export</Button>}>
          Grid
        </TemplateGridEditor>
        <TemplateDocument
          outline={<nav aria-label="Outline">Outline</nav>}
          acknowledgments={<p>I agree</p>}
        >
          Text
        </TemplateDocument>
        <TemplateAuth brand={<BrandMark name="Northwind Live" />}>Sign in</TemplateAuth>
        <TemplateGatewayShell
          topNav={<header>Top</header>}
          aside={<p>Up Next</p>}
          tabBar={<nav aria-label="Tabs">Tabs</nav>}
        >
          Feed
        </TemplateGatewayShell>
        <TemplateGatewayShell topNav={<header>Top</header>}>Feed only</TemplateGatewayShell>
        <TemplateSystem
          icon="SearchX"
          title="Page not found"
          sentence="Check the address."
          actionLabel="Go Home"
          onAction={onAction}
          reference="REF-404"
        />
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Go Home" }));
    expect(onAction).toHaveBeenCalled();
    expect(screen.getByText("REF-404")).toBeTruthy();
    await expectAccessible(container);
  });
});
