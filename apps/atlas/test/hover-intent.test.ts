import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hoverIntent, OPEN_DELAY_MS } from "../lib/hover/intent";

describe("hover card timing (Section 11.7)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits 400 ms on a key before the card shows", () => {
    const show = vi.fn();
    const intent = hoverIntent<string, string>(show);
    expect(OPEN_DELAY_MS).toBe(400);
    expect(intent.enter("NWS-1", "card 1")).toBe(true);
    vi.advanceTimersByTime(399);
    expect(show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(show).toHaveBeenCalledExactlyOnceWith("card 1", "NWS-1");
  });

  it("keeps waiting while the pointer moves within the same key", () => {
    const show = vi.fn();
    const intent = hoverIntent<string, string>(show);
    intent.enter("NWS-1", "card 1");
    vi.advanceTimersByTime(300);
    expect(intent.enter("NWS-1", "card 1")).toBe(false);
    vi.advanceTimersByTime(100);
    expect(show).toHaveBeenCalledOnce();
  });

  it("starts again on another key, and shows only the last one", () => {
    const show = vi.fn();
    const intent = hoverIntent<string, string>(show);
    intent.enter("NWS-1", "card 1");
    vi.advanceTimersByTime(300);
    expect(intent.enter("NWS-2", "card 2")).toBe(true);
    vi.advanceTimersByTime(300);
    expect(show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(show).toHaveBeenCalledExactlyOnceWith("card 2", "NWS-2");
  });

  it("shows nothing when the pointer leaves first or the part has nothing to preview", () => {
    const show = vi.fn();
    const intent = hoverIntent<string, string>(show);
    intent.enter("NWS-1", "card 1");
    vi.advanceTimersByTime(399);
    intent.leave();
    vi.advanceTimersByTime(1_000);
    expect(show).not.toHaveBeenCalled();
    expect(intent.enter("NWS-1")).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(show).not.toHaveBeenCalled();
    // Coming back after leaving waits the full delay again.
    intent.leave();
    intent.enter("NWS-1", "card 1");
    vi.advanceTimersByTime(399);
    expect(show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(show).toHaveBeenCalledOnce();
  });

  it("takes another delay", () => {
    const show = vi.fn();
    const intent = hoverIntent<string, string>(show, 50);
    intent.enter("NWS-1", "card 1");
    vi.advanceTimersByTime(50);
    expect(show).toHaveBeenCalledOnce();
  });
});
