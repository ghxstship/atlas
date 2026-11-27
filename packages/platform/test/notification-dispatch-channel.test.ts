import { describe, expect, it, vi } from "vitest";
import {
  channel,
  channelFailure,
} from "../../../supabase/functions/notification-dispatch/channel.ts";

// CodeQL alert 23 (js/stack-trace-exposure): a failed channel's error text went into the function's response.
describe("a notification-dispatch channel", () => {
  it("returns what the channel returns", async () => {
    const logger = { error: vi.fn() };
    expect(await channel(logger, "email", async () => ({ sent: 3 }))).toEqual({ sent: 3 });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs a failure's reason and answers with a fixed sentence", async () => {
    const logger = { error: vi.fn() };
    const failure = new Error("provider said: invalid key sk_live_example at line 12");
    const result = await channel(logger, "sms", async () => {
      throw failure;
    });
    expect(result).toEqual(channelFailure("sms"));
    expect(JSON.stringify(result)).not.toContain("provider said");
    expect(logger.error).toHaveBeenCalledWith("A notification channel failed.", {
      channel: "sms",
      error: failure.message,
    });
  });

  it("handles a thrown value that is not an Error", async () => {
    const logger = { error: vi.fn() };
    const result = await channel(logger, "push", () => Promise.reject("refused"));
    expect(result).toEqual({ error: "The push channel failed; the function log has the reason." });
    expect(logger.error).toHaveBeenCalledWith("A notification channel failed.", {
      channel: "push",
      error: "refused",
    });
  });
});
