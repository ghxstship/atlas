/**
 * The notification worker runs once a minute. Sending one batch a channel a run, a crisis alert to a whole project
 * (6070) reached the last phone many minutes later. drain runs a channel's dispatch again while its last batch handed
 * out anything, until the channel's time in the run or its batch count is spent. A batch can hand out fewer than it
 * asked for with more still waiting, since the claim suppresses or defers some of the rows it takes (no device, quiet
 * hours), so only an empty batch means the queue is empty. The claim hands out the kinds that
 * always bypass quiet hours first, so a crisis alert goes before any backlog.
 */

export interface DrainOptions {
  /** Deliveries claimed at a time. */
  readonly batch: number;
  /** No new batch starts once this much of the run has gone on the channel. */
  readonly budgetMs: number;
  /** At most this many batches, which bounds the run's CPU whatever the time. */
  readonly maxBatches: number;
  readonly now?: () => number;
}

/** Each batch's counts are added up; a summary holds counts only. */
export async function drain<S extends { readonly attempted: number }>(
  run: (limit: number) => Promise<S>,
  options: DrainOptions,
): Promise<S & { readonly batches: number }> {
  const now = options.now ?? Date.now;
  const started = now();
  const total: Record<string, number> = {};
  let batches = 0;
  for (;;) {
    const summary = await run(options.batch);
    batches += 1;
    for (const [key, value] of Object.entries(summary))
      if (typeof value === "number") total[key] = (total[key] ?? 0) + value;
    if (
      summary.attempted === 0 ||
      batches >= options.maxBatches ||
      now() - started >= options.budgetMs
    )
      break;
  }
  return { ...(total as unknown as S), batches };
}
