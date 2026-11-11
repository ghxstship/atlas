import { describe, expect, it, vi } from "vitest";
import {
  forgetWaitingRefresh,
  holdLiveRefresh,
  liveRefreshHeld,
  refreshWhenFree,
} from "../components/live/live-hold";

/**
 * RRR-243: a dialog showing a signing link and access code once holds live refreshes, so the
 * refresh its own send causes cannot unmount it; the page rereads once the dialog closes.
 */
describe("live refresh holds", () => {
  it("refreshes at once when nothing holds", () => {
    const refresh = vi.fn();
    refreshWhenFree({}, refresh);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(liveRefreshHeld()).toBe(false);
  });

  it("waits for the last hold, then rereads each page once", () => {
    const page = {};
    const other = {};
    const first = vi.fn();
    const second = vi.fn();
    const otherRefresh = vi.fn();
    const releaseA = holdLiveRefresh();
    const releaseB = holdLiveRefresh();
    expect(liveRefreshHeld()).toBe(true);
    refreshWhenFree(page, first);
    refreshWhenFree(page, second);
    refreshWhenFree(other, otherRefresh);
    releaseA();
    expect(second).not.toHaveBeenCalled();
    releaseA();
    expect(second).not.toHaveBeenCalled();
    releaseB();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(otherRefresh).toHaveBeenCalledTimes(1);
    expect(liveRefreshHeld()).toBe(false);
    releaseB();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("drops the waiting refresh of a page that has left", () => {
    const page = {};
    const refresh = vi.fn();
    const release = holdLiveRefresh();
    refreshWhenFree(page, refresh);
    forgetWaitingRefresh(page);
    release();
    expect(refresh).not.toHaveBeenCalled();
  });
});
