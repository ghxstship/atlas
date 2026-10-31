import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { FilePreviewer, MapView, RichTextEditor, toLngLat } from "../src/index.ts";
import { expectAccessible } from "./a11y.ts";

/* ProseMirror (Tiptap) reads layout from point APIs jsdom leaves out; stubbed for these tests only. */
const original = document.elementFromPoint;
beforeAll(() => {
  document.elementFromPoint = () => null;
});
afterAll(() => {
  document.elementFromPoint = original;
});

describe("RichTextEditor", () => {
  it("renders the document, formats from the toolbar and reports changes", async () => {
    const onChange = vi.fn();
    const onRequestLink = vi.fn(() => "https://example.org");
    const { container } = render(
      <RichTextEditor
        label="Notes"
        html="<p>Load-in at seven</p>"
        presence={<span>2 editing</span>}
        onChange={onChange}
        onRequestLink={onRequestLink}
      />,
    );
    const box = screen.getByRole("textbox", { name: "Notes" });
    expect(box.textContent).toContain("Load-in at seven");
    expect(screen.getByRole("toolbar", { name: "Formatting" })).toBeTruthy();
    const bold = screen.getByRole("button", { name: "Bold" });
    expect(bold.getAttribute("title")).toBe("Bold (⌘B)");
    await userEvent.click(box);
    await userEvent.keyboard("{Control>}a{/Control}");
    await userEvent.click(bold);
    await userEvent.click(screen.getByRole("button", { name: "Italic" }));
    await userEvent.click(screen.getByRole("button", { name: "Bulleted list" }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(String(onChange.mock.lastCall?.[0])).toMatch(/<(strong|em|ul)/);
    await userEvent.click(screen.getByRole("button", { name: "Link" }));
    await waitFor(() => expect(onRequestLink).toHaveBeenCalled());
    await expectAccessible(container);
  });

  it("co-edits through a Yjs document", async () => {
    const ydoc = new Y.Doc();
    render(<RichTextEditor label="Shared" html="" ydoc={ydoc} editable />);
    const box = screen.getByRole("textbox", { name: "Shared" });
    expect(box).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Link" })).toBeNull();
    act(() => {
      ydoc.getXmlFragment("default");
    });
  });
});

describe("FilePreviewer", () => {
  it("pages, zooms and downloads", async () => {
    const onPage = vi.fn();
    const onZoomIn = vi.fn();
    const onDownload = vi.fn();
    const { container } = render(
      <FilePreviewer
        name="Rider.pdf"
        meta="12 pages"
        pages={3}
        page={0}
        zoom="125%"
        onPage={onPage}
        onZoomIn={onZoomIn}
        onDownload={onDownload}
      >
        <p>Page body</p>
      </FilePreviewer>,
    );
    expect(screen.getByRole("button", { name: "Page 1" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await userEvent.click(screen.getByRole("button", { name: "Page 3" }));
    expect(onPage).toHaveBeenCalledWith(2);
    expect(screen.getByRole("button", { name: "Page 3" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await userEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(onZoomIn).toHaveBeenCalled();
    expect(onDownload).toHaveBeenCalled();
    await expectAccessible(container);
  });
});

describe("FilePreviewer for one-page files", () => {
  it("leaves out the page rail for one page and the zoom for a file without it", async () => {
    const { container } = render(
      <FilePreviewer name="clip.mp4" meta="Video" pages={0} zoomable={false} onDownload={vi.fn()}>
        <p>Player</p>
      </FilePreviewer>,
    );
    expect(screen.queryByRole("button", { name: /^Page / })).toBeNull();
    expect(screen.queryByRole("button", { name: "Zoom in" })).toBeNull();
    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
    await expectAccessible(container);
  });

  it("offers no download while there is nothing to download", () => {
    render(
      <FilePreviewer name="Rider.pdf" meta="" pages={1} downloadable={false}>
        <p>Loading</p>
      </FilePreviewer>,
    );
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Page 1" })).toBeNull();
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeTruthy();
  });
});

describe("MapView", () => {
  const props = {
    label: "Site plan",
    width: 400,
    height: 200,
    zones: [{ label: "Stage", x: 10, y: 10, w: 120, h: 80 }],
    pins: [
      { x: 60, y: 40, label: "First aid" },
      { x: 200, y: 120, label: "Incident", tone: "danger" as const },
    ],
    geofence: { x: 200, y: 100, r: 80 },
  };

  it("draws zones, pins and the geofence with a numbered legend", async () => {
    const { container } = render(<MapView {...props} />);
    expect(screen.getByRole("img", { name: "Site plan" })).toBeTruthy();
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "1First aid",
      "2Incident",
    ]);
    expect(container.querySelectorAll("circle")).toHaveLength(3);
    await expectAccessible(container);
  });

  it("keeps the drawing when tiles cannot load", async () => {
    render(
      <MapView
        {...props}
        geo={{ styleUrl: "https://tiles.example/style.json", bounds: [-80.2, 25.79, -80.19, 25.8] }}
      />,
    );
    expect(screen.getByRole("img", { name: "Site plan" }).getAttribute("class")).not.toContain(
      "opacity-0",
    );
  });

  it("maps drawing points onto the geo bounds", () => {
    expect(toLngLat(0, 0, 100, 100, [-80, 25, -79, 26])).toEqual([-80, 26]);
    expect(toLngLat(100, 100, 100, 100, [-80, 25, -79, 26])).toEqual([-79, 25]);
  });
});
