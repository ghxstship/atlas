import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  Avatar,
  AvatarStack,
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  CurrencyInput,
  DepartmentChip,
  DepartmentGlyph,
  Divider,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  InlineAlert,
  Input,
  Kbd,
  Keys,
  Link,
  Money,
  NumberInput,
  PhaseChip,
  PhaseGlyph,
  PropertyChip,
  Radio,
  RecordKindChip,
  RecordKindGlyph,
  RefusalNotice,
  Select,
  Skeleton,
  StateChip,
  StateIcon,
  Switch,
  Tag,
  Textarea,
  Toast,
  ToastRegion,
  URIDChip,
  UndoToast,
  XOSProvider,
} from "../src/index.ts";
import { recordStates } from "@xos/icons";
import { expectAccessible } from "./a11y.ts";

describe("Icon and glyphs", () => {
  it("resolves PascalCase, kebab-case and aliases, hidden unless labeled", async () => {
    const { container } = render(
      <div>
        <Icon name="Hammer" />
        <Icon name="chevron-right" label="Next" />
        <Icon name="more" />
        <Icon name="NoSuchIcon" />
        <DepartmentGlyph code="4000" label="Environment" />
        <PhaseGlyph code="BLD" />
        <RecordKindGlyph kind="Task" size={20} color="var(--color-text-secondary)" />
      </div>,
    );
    expect(screen.getByRole("img", { name: "Next" }).getAttribute("class")).toContain(
      "xos-flip-rtl",
    );
    expect(screen.getByRole("img", { name: "Environment" })).toBeTruthy();
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThanOrEqual(4);
    await expectAccessible(container);
  });

  it("draws all nine record states with a distinct shape", async () => {
    const { container } = render(
      <div>
        {recordStates.map((s) => (
          <StateIcon key={s} state={s} />
        ))}
      </div>,
    );
    const svgs = [...container.querySelectorAll("svg")];
    expect(svgs).toHaveLength(9);
    expect(new Set(svgs.map((s) => s.innerHTML)).size).toBe(9);
    await expectAccessible(container);
  });
});

describe("Button, IconButton, Link and Kbd", () => {
  it("renders variants, icon and shortcut and fires on Enter and Space", async () => {
    const onClick = vi.fn();
    const { container } = render(
      <div>
        <Button variant="primary" icon="Plus" shortcut="C" onClick={onClick}>
          Create Record
        </Button>
        <Button variant="danger" size="sm">
          Delete
        </Button>
        <Button variant="ghost" size="lg" disabled>
          Cancel
        </Button>
      </div>,
    );
    const button = screen.getByRole("button", { name: /Create Record/ });
    button.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(2);
    expect(button.querySelector("kbd")?.textContent).toBe("C");
    expect(button.getAttribute("type")).toBe("button");
    await expectAccessible(container);
  });

  it("blocks repeat clicks while loading without losing focus", async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Save" });
    expect(button.getAttribute("aria-busy")).toBe("true");
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("labels an icon button and puts the shortcut in the tooltip", async () => {
    const { container } = render(<IconButton icon="Search" label="Search" shortcut="⌘ K" />);
    const button = screen.getByRole("button", { name: "Search" });
    expect(button.getAttribute("title")).toBe("Search (⌘ K)");
    await expectAccessible(container);
  });

  it("opens external links in a new tab and says so", async () => {
    const { container } = render(
      <p>
        <Link href="/records">Records</Link>{" "}
        <Link href="https://example.org" external>
          Docs
        </Link>
      </p>,
    );
    const ext = screen.getByRole("link", { name: /Docs/ });
    expect(ext.getAttribute("target")).toBe("_blank");
    expect(ext.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByRole("img", { name: "Opens in a new tab" })).toBeTruthy();
    await expectAccessible(container);
  });

  it("splits a shortcut into keys", () => {
    const { container } = render(
      <>
        <Kbd>?</Kbd>
        <Keys keys="G  P" />
      </>,
    );
    expect([...container.querySelectorAll("kbd")].map((k) => k.textContent)).toEqual([
      "?",
      "G",
      "P",
    ]);
  });
});

describe("chips, tag, badge and avatars", () => {
  it("renders plain words before codes", async () => {
    const onClick = vi.fn();
    const { container } = render(
      <div>
        <StateChip state="active" label="Active" onClick={onClick} />
        <StateChip state="blocked" label="Blocked" compact />
        <PhaseChip gate={3} name="Advance" code="ADV" />
        <DepartmentChip name="Production" code="5000" />
        <URIDChip name="Line Array Package" urid="5000.01.003" />
        <RecordKindChip kind="Inspection" />
        <RecordKindChip kind="Task" label="To Do" />
        <PropertyChip label="Owner" value="Dana Ortiz" icon="User" onClick={onClick} />
        <PropertyChip value="Nov 3" />
        <Tag tone="danger">Blocking</Tag>
        <Tag>Draft</Tag>
        <Badge count={120} tone="danger" label="120 new" />
        <Badge count={4} tone="accent" />
        <Badge count={2} />
      </div>,
    );
    expect(screen.getByText("Gate 3 · Advance")).toBeTruthy();
    expect(screen.getByText("5000")).toBeTruthy();
    expect(screen.getByText("Blocked").className).toContain("sr-only");
    expect(screen.getByRole("img", { name: "120 new" }).textContent).toBe("99+");
    await userEvent.click(screen.getByRole("button", { name: /Active/ }));
    await userEvent.click(screen.getByRole("button", { name: /Owner/ }));
    expect(onClick).toHaveBeenCalledTimes(2);
    await expectAccessible(container);
  });

  it("shows initials and folds the rest of a stack into a count", async () => {
    const { container } = render(
      <div>
        <Avatar name="Dana Ortiz" size="lg" />
        <AvatarStack names={["Ana Ruiz", "Ben Cole", "Cy Park", "Di Wu", "Ed Lim"]} />
      </div>,
    );
    expect(screen.getByRole("img", { name: "Dana Ortiz" }).textContent).toBe("DO");
    expect(screen.getByRole("img", { name: "2 more" }).textContent).toBe("+2");
    await expectAccessible(container);
  });
});

describe("form fields", () => {
  it("labels inputs and describes them by help or error", async () => {
    const { container } = render(
      <form>
        <Input label="Title" help="Shown on the record." placeholder="Untitled" />
        <Input label="Email" error="Email needs an @. Add the domain." width={320} />
        <Textarea label="Notes" help="Markdown is supported." />
      </form>,
    );
    const title = screen.getByLabelText("Title");
    expect(title.getAttribute("aria-describedby")).toMatch(/-help$/);
    const email = screen.getByLabelText("Email");
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById(email.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toContain("Email needs an @");
    await userEvent.type(title, "Load-in");
    expect((title as HTMLInputElement).value).toBe("Load-in");
    await expectAccessible(container);
  });

  it("keeps the native select change event", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <Select
        label="Department"
        placeholder="Choose"
        options={[
          { value: "5000", label: "Production" },
          { value: "6000", label: "Operations" },
        ]}
        onChange={onChange}
      />,
    );
    await userEvent.selectOptions(screen.getByLabelText("Department"), "6000");
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls[0]?.[0].target.value).toBe("6000");
    await expectAccessible(container);
  });

  it("toggles checkbox and switch with Space and moves radios with arrows", async () => {
    const onRadio = vi.fn();
    const { container } = render(
      <div>
        <Checkbox label="Attach a screenshot" />
        <Switch label="Notify crew" defaultChecked />
        <Radio
          label="Grade"
          value="base"
          onChange={onRadio}
          options={[
            { value: "base", label: "Base" },
            { value: "elevated", label: "Elevated", help: "Adds premium rigging." },
          ]}
        />
      </div>,
    );
    const box = screen.getByRole("checkbox", { name: "Attach a screenshot" }) as HTMLInputElement;
    box.focus();
    await userEvent.keyboard(" ");
    expect(box.checked).toBe(true);
    const sw = screen.getByRole("switch", { name: "Notify crew" }) as HTMLInputElement;
    expect(sw.checked).toBe(true);
    await userEvent.click(sw);
    expect(sw.checked).toBe(false);
    await userEvent.click(screen.getByRole("radio", { name: /Elevated/ }));
    expect(onRadio).toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "Grade" })).toBeTruthy();
    await expectAccessible(container);
  });

  it("steps numbers with buttons and arrows and keeps blank as null", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <NumberInput label="Crew" unit="people" min={0} max={3} onChange={onChange} />,
    );
    const input = screen.getByLabelText("Crew") as HTMLInputElement;
    await userEvent.click(screen.getByRole("button", { name: "Increase" }));
    expect(onChange).toHaveBeenLastCalledWith(1);
    input.focus();
    await userEvent.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}");
    expect(input.value).toBe("3");
    await userEvent.keyboard("{ArrowDown}");
    expect(input.value).toBe("2");
    await userEvent.click(screen.getByRole("button", { name: "Decrease" }));
    expect(input.value).toBe("1");
    await userEvent.clear(input);
    expect(onChange).toHaveBeenLastCalledWith(null);
    await userEvent.type(input, "abc");
    expect(onChange).toHaveBeenLastCalledWith(null);
    await expectAccessible(container);
  });

  it("renders null money as Unpriced and never as zero", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <div>
        <Money amount={null} />
        <Money amount={0} />
        <Money amount={1250} currency="EUR" />
        <Money amount={null} unpricedLabel="Rate on Request" />
        <CurrencyInput label="Rate" value={null} onChange={onChange} />
        <CurrencyInput label="Fee" value={120} help="Per day." />
      </div>,
    );
    expect(screen.getByText("Unpriced")).toBeTruthy();
    expect(screen.getByText("$0.00")).toBeTruthy();
    expect(screen.getByText("€1,250.00")).toBeTruthy();
    expect(screen.getByText("Rate on Request")).toBeTruthy();
    const rate = screen.getByLabelText("Rate") as HTMLInputElement;
    expect(rate.value).toBe("");
    expect(rate).toMatchObject({ placeholder: "Unpriced" });
    expect(screen.getByText(/Blank means unpriced/)).toBeTruthy();
    await userEvent.type(rate, "0");
    expect(onChange).toHaveBeenCalled();
    expect(screen.queryByText(/Blank means unpriced/)).toBeNull();
    expect((screen.getByLabelText("Fee") as HTMLInputElement).value).toBe("120");
    await expectAccessible(container);
  });

  it("reads copy in es-US", () => {
    render(
      <XOSProvider locale="es-US">
        <Money amount={null} />
      </XOSProvider>,
    );
    expect(screen.queryByText("Unpriced")).toBeNull();
  });
});

describe("surfaces and states", () => {
  it("renders card, divider and skeleton", async () => {
    const { container } = render(
      <div>
        <Card title="Budget" meta="3 lines" footer={<Button>Export</Button>} interactive>
          Body
        </Card>
        <Card>Plain</Card>
        <Divider />
        <Divider label="Earlier" />
        <Skeleton />
        <Skeleton width={80} height="1rem" />
      </div>,
    );
    expect(screen.getByRole("separator", { name: "Earlier" })).toBeTruthy();
    expect(container.querySelectorAll(".xos-anim-pulse")).toHaveLength(2);
    await expectAccessible(container);
  });

  it("renders empty, error and refusal states with their actions", async () => {
    const onAction = vi.fn();
    const { container } = render(
      <div>
        <EmptyState
          sentence="No shifts yet."
          actionLabel="Post Crew Call"
          icon="CalendarClock"
          shortcut="C"
          onAction={onAction}
        />
        <ErrorState
          title="Budget did not load"
          sentence="The server timed out."
          reference="ERR-504-7F2"
          onRetry={onAction}
        />
        <RefusalNotice
          outcome="NO_ANSWER"
          title="No wage rule"
          reason="This jurisdiction has no rule."
          actionLabel="View Jurisdiction"
          onAction={onAction}
        />
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: /Post Crew Call/ }));
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await userEvent.click(screen.getByRole("button", { name: "View Jurisdiction" }));
    expect(onAction).toHaveBeenCalledTimes(3);
    expect(screen.getByText("NO_ANSWER")).toBeTruthy();
    await expectAccessible(container);
  });

  it("announces alerts and banners by tone", async () => {
    const onDismiss = vi.fn();
    const onAction = vi.fn();
    const { container } = render(
      <div>
        <InlineAlert tone="danger" title="Overbooked">
          Two crews share one slot.
        </InlineAlert>
        <InlineAlert>Saved.</InlineAlert>
        <Banner tone="warning" actionLabel="Review" onAction={onAction} onDismiss={onDismiss}>
          Trial ends in 3 days.
        </Banner>
        <Banner tone="danger" icon="WifiOff">
          Offline.
        </Banner>
        <Banner tone="success">Done.</Banner>
      </div>,
    );
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(onDismiss).toHaveBeenCalled();
    expect(onAction).toHaveBeenCalled();
    await expectAccessible(container);
  });

  it("shows toasts in a region and undoes on the button or Cmd+Z", async () => {
    const onUndo = vi.fn();
    const onAction = vi.fn();
    const { container, unmount } = render(
      <ToastRegion label="Notifications">
        <Toast
          message="Record archived."
          actionLabel="View"
          actionIcon="Eye"
          shortcut="V"
          onAction={onAction}
        />
        <UndoToast message="3 records deleted." onUndo={onUndo} />
      </ToastRegion>,
    );
    await userEvent.click(screen.getByRole("button", { name: /View/ }));
    expect(onAction).toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "z", metaKey: true });
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: /Undo/ }) as HTMLButtonElement).disabled).toBe(true);
    await expectAccessible(container);
    unmount();
  });

  it("expires the undo toast after its seconds", () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const onUndo = vi.fn();
    render(<UndoToast message="Moved." seconds={2} onExpire={onExpire} onUndo={onUndo} />);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(onExpire).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("undoes from the button", async () => {
    const onUndo = vi.fn();
    render(<UndoToast message="Moved." onUndo={onUndo} />);
    await userEvent.click(screen.getByRole("button", { name: /Undo/ }));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });
});
