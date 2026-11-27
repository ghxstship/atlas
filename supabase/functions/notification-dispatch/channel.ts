// One channel of a notification-dispatch run. A channel that throws is logged with its reason and answered with a
// fixed sentence: the response goes back to the scheduler (pg_cron keeps it in net._http_response), and an error's
// own text can carry a provider's reply or a stack, which belongs in the function log only.

/** The part of the platform logger a channel needs. */
export interface ChannelLogger {
  error(message: string, fields: Record<string, unknown>): void;
}

/** The fixed reply for a channel that failed. */
export function channelFailure(name: string): { error: string } {
  return { error: `The ${name} channel failed; the function log has the reason.` };
}

/** Runs one channel, returning its result or, when it throws, the fixed failure reply. */
export async function channel<T>(
  logger: ChannelLogger,
  name: string,
  run: () => Promise<T>,
): Promise<T | { error: string }> {
  try {
    return await run();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.error("A notification channel failed.", { channel: name, error: reason });
    return channelFailure(name);
  }
}
