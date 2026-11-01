/**
 * The schedule's fill-rate meter (Section 11.11 crew fill, A132): how many of the week's live shifts have someone
 * on them. It holds no state, so the server renders it for readers and the drag board renders it with the counts it
 * updates as planners assign; `valueText` is the sentence assistive technology reads.
 */
export function FillMeter(props: {
  label: string;
  filled: number;
  total: number;
  percent: number;
  valueText: string;
  /**
   * Live agency slots (R12): allocated to a staffing agency that has not placed anyone yet. They show as a second,
   * unfilled segment after the filled one, with their own sentence; 0 or absent shows none.
   */
  allocated?: number;
  allocatedText?: string;
}) {
  const allocated = props.allocated ?? 0;
  const allocatedPercent =
    props.total === 0
      ? 0
      : Math.min(100 - props.percent, Math.round((allocated / props.total) * 100));
  return (
    <div className="flex min-w-(--space-64) flex-1 flex-col gap-6" data-testid="fill-meter">
      <div className="flex items-baseline justify-between gap-8 text-text-12">
        <span id="fill-meter-label" className="font-medium text-text-primary">
          {props.label}
        </span>
        <span className="tabular-nums text-text-secondary" aria-hidden="true">
          {props.valueText}
        </span>
      </div>
      <div
        role="meter"
        aria-labelledby="fill-meter-label"
        aria-valuemin={0}
        aria-valuemax={Math.max(props.total, 1)}
        aria-valuenow={props.filled}
        aria-valuetext={props.valueText}
        className="flex h-(--space-4) overflow-hidden rounded-pill bg-bg-hover"
      >
        <div
          className={
            props.percent >= 100
              ? "h-full rounded-pill bg-success forced-colors:bg-[Highlight]"
              : "h-full rounded-pill bg-accent forced-colors:bg-[Highlight]"
          }
          style={{ inlineSize: `${props.percent}%` }}
        />
        {allocatedPercent > 0 ? (
          <div
            data-testid="fill-meter-allocated"
            className="h-full bg-text-tertiary forced-colors:bg-[GrayText]"
            style={{ inlineSize: `${allocatedPercent}%` }}
          />
        ) : null}
      </div>
      {allocated > 0 && props.allocatedText ? (
        <span className="text-text-12 text-text-secondary">{props.allocatedText}</span>
      ) : null}
    </div>
  );
}
