import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeComponentNames } from "../src/components.ts";
import * as root from "../src/index.ts";
import {
  clockHeld,
  GalleryScreen,
  galleryPage,
  galleryPages,
  galleryThemes,
  holdClock,
  HELD_TIMER_MS,
  pagesShowing,
} from "../src/gallery/index.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("component gallery pages", () => {
  it("shows each of the 49 components on at least one page", () => {
    expect(nativeComponentNames).toHaveLength(49);
    const shown = new Set(galleryPages.flatMap((p) => p.entries.map((e) => e.component)));
    expect([...shown].sort()).toEqual([...nativeComponentNames].sort());
    for (const name of nativeComponentNames)
      expect(pagesShowing(name).length, name).toBeGreaterThan(0);
  });

  it("names every page once and lists a component once per page", () => {
    const keys = galleryPages.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const page of galleryPages) {
      const names = page.entries.map((e) => e.component);
      expect(new Set(names).size, page.key).toBe(names.length);
    }
  });

  it("is not exported from the package root, so apps bundle it only when they open the gallery", () => {
    expect(Object.keys(root)).not.toContain("GalleryScreen");
    expect(Object.keys(root)).not.toContain("galleryPages");
  });

  it("falls back to the first page for a page number out of range", () => {
    expect(galleryPage(2).index).toBe(1);
    expect(galleryPage(0).index).toBe(0);
    expect(galleryPage(galleryPages.length + 1).index).toBe(0);
    expect(galleryPage(Number.NaN).index).toBe(0);
  });
});

describe.each(galleryThemes)("gallery in %s", (theme) => {
  it.each(galleryPages.map((page, i) => [i + 1, page.key] as const))(
    "renders page %i (%s) with every component it lists",
    (number) => {
      const warn = vi.spyOn(console, "warn");
      const { container, getByTestId, unmount } = render(
        <GalleryScreen
          theme={theme}
          page={number}
          insets={{ top: 62, bottom: 34 }}
          testID="page"
        />,
      );
      const page = galleryPages[number - 1];
      expect(getByTestId("page").textContent).toContain(
        `${theme} ${number}/${galleryPages.length}`,
      );
      for (const entry of page?.entries ?? []) {
        const box = getByTestId(`gallery-${entry.component}`);
        // The label and something drawn under it.
        expect(box.childElementCount, entry.component).toBeGreaterThan(1);
      }
      expect(container.innerHTML.length).toBeGreaterThan(0);
      // An unknown icon name warns and draws an empty box, which a snapshot would keep as a gap.
      expect(warn).not.toHaveBeenCalled();
      unmount();
    },
  );
});

describe("fixed clock", () => {
  it("holds timers of a second or longer and lets shorter ones run", () => {
    vi.useFakeTimers();
    const slow = vi.fn();
    const fast = vi.fn();
    const release = holdClock();
    expect(clockHeld()).toBe(true);
    const held = setTimeout(slow, HELD_TIMER_MS);
    setInterval(slow, 5000);
    setTimeout(fast, 10);
    vi.advanceTimersByTime(60_000);
    expect(slow).not.toHaveBeenCalled();
    expect(fast).toHaveBeenCalledOnce();
    clearTimeout(held);
    const real = setTimeout(fast, 0);
    clearTimeout(real);
    clearInterval(undefined);
    release();
    release();
    expect(clockHeld()).toBe(false);
    setTimeout(slow, HELD_TIMER_MS);
    vi.advanceTimersByTime(HELD_TIMER_MS);
    expect(slow).toHaveBeenCalledOnce();
  });

  it("nests holds and runs again when the last one is released", () => {
    const first = holdClock();
    const second = holdClock();
    first();
    expect(clockHeld()).toBe(true);
    second();
    expect(clockHeld()).toBe(false);
  });

  it("keeps UndoToast at its first second while the gallery is open", () => {
    vi.useFakeTimers();
    const index = galleryPages.findIndex((p) => p.entries.some((e) => e.component === "UndoToast"));
    const { getByTestId, unmount } = render(<GalleryScreen theme="dark" page={index + 1} />);
    const toast = () => getByTestId("gallery-UndoToast").textContent;
    const first = toast();
    expect(first).toContain("8");
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(toast()).toBe(first);
    expect(clockHeld()).toBe(true);
    unmount();
    expect(clockHeld()).toBe(false);
  });
});
